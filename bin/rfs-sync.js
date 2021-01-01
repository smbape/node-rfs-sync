#!/usr/bin/env node


/* eslint-disable no-magic-numbers */

const fs = require("fs");
const read = require("read");
const {Client} = require("ssh2");
const SyncWriteStream = require("syncwritestream");
const eachSeries = require("async/eachSeries");
const log4js = require("log4js");
const {upload, protocols} = require("../");

const logger = log4js.getLogger("rfs-sync-cli");

const MAX_ATTEMPTS = 3;
const SSH_DEFAULT_PORT = 22;
const emptyFn = Function.prototype;

log4js.configure({
    "appenders": {
        "console": {
            "type": "console",
            "layout": {
                "type": "colored"
            }
        }
    },
    "categories": {
        "default": {
            "appenders": ["console"],
            "level": process.env.LEVEL || "DEBUG"
        }
    }
});

function tryNextAuth(stdin, stdout, config, auths, next) {
    // eslint-disable-next-line no-invalid-this
    const context = this;

    if (!context.attempts) {
        stdout.write(`Using username "${ config.username }".\n`);
        context.attempts = 0;
    } else {
        stdout.write("Access denied\n");
    }

    if (context.attempts === MAX_ATTEMPTS) {
        stdout.write(`Authentication with password failed after ${ MAX_ATTEMPTS } attempts\n`);
        next();
        return;
    }

    context.attempts++;
    read({
        prompt: `${ config.username }@${ config.host }${ config.port === SSH_DEFAULT_PORT ? "" : `:${ config.port }` }'s password:`,
        silent: true,
        input: stdin,
        output: stdout,
        terminal: Boolean(stdout.isTTY) || Boolean(stdin.isTTY)
    }, (err, password, isDefault) => {
        if (err) {
            stdout.write(`${ err }\n`);
            auths.push(tryNextAuth.bind(context, stdin, stdout));
            next();
            return;
        }

        config.password = password;
        auths.push("password", tryNextAuth.bind(context, stdin, stdout));
        next();
    });
}

const onKeyboardInteractive = (stdin, stdout, name, instructions, lang, prompts, callback) => {
    const len = prompts.length;
    const answers = [];
    let index = 0;

    const nextPrompt = () => {
        if (index === len) {
            callback(answers);
            return;
        }

        const prompt = prompts[index++];
        read({
            prompt,
            silent: !prompt.echo,
            input: stdin,
            output: stdout
        }, (err, answer, isDefault) => {
            if (err) {
                throw err;
            }

            answers.push(answer);
            nextPrompt();
        });
    };

    nextPrompt();
};

const connect = function(options, callback) {
    if (arguments.length === 1) {
        callback = options;
        options = null;
    }

    if (!callback) {
        callback = emptyFn;
    }

    options = Object.assign({}, options);

    let connectionID = `${ encodeURIComponent(options.username) }@${ encodeURIComponent(options.host) }`;
    if (options.port !== SSH_DEFAULT_PORT) {
        connectionID += `:${ options.port }`;
    }

    const stdio = options.stdio !== "inherit" && options.stdio || [0, 1, 2];
    const stdin = stdio[0] === 0 ? process.stdin : stdio[0];
    const stdout = stdio[1] === 1 ? process.stdout : stdio[1];
    // const stderr = stdio[2] === 2 ? process.stderr : stdio[2];

    if (!options.tryNextAuth) {
        options.tryNextAuth = tryNextAuth.bind(options, stdin, stdout);
    }

    const client = new Client();

    if (options.tryKeyboard) {
        client.on("keyboard-interactive", onKeyboardInteractive.bind(options, stdin, stdout));
    }

    client.once("ready", onready);
    client.once("error", onerror);

    client.on("end", () => {
        logger.info(`Connection to ${ connectionID } closed.`);
    });

    client.end = (_end => {
        return function end() {
            this.once("error", err => {
                if (err.code !== "ECONNRESET") {
                    if (this.listenerCount("error") === 0) {
                        throw err;
                    }
                    return;
                }

                this.emit("end");
            });

            _end.call(this);
        };
    })(client.end);

    client.connect(options);

    function onready() {
        logger.info(`Connection to ${ connectionID } opened.`);
        client.removeListener("error", onerror);
        callback(null, client);
    }

    function onerror(err) {
        client.removeListener("ready", onready);
        callback(err);
    }

    return client;
};

const defaultParams = {
    // privateKey: sysPath.join(HOME_DIR, ".ssh", "id_rsa"),
    readyTimeout: 15 * 1000,
    agent: process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "pageant" : undefined),
    host: process.env.SSH_HOST || "127.0.0.1",
    port: process.env.SSH_PORT ? parseInt(process.env.SSH_PORT, 10) : 22,
};

const collect = (val, memo) => {
    memo.push(val);
    return memo;
};

const program = require("commander");
program
    .version(require("../package.json").version)
    .usage("[options] <username>@<hostname>")
    .option("--password <password>", "Specifies the password to use on the remote machine")
    .option("-p, --port <port>", `Port to connect to on the remote host [${ defaultParams.port }]`, parseInt)
    .option("--private-key [path]", `Path to private key [${ defaultParams.privateKey }]`, defaultParams.privateKey)
    .option("--passphrase <passphrase>", "Private key passphrase")
    .option("--agent [agent]", `Authentication agent [${ defaultParams.agent }]`, defaultParams.agent)
    .option("--raw", [
        "Use raw stdout and stderr.",
        "Usefull on windows when your console already support vt100 special characters.",
        "See: http://stackoverflow.com/questions/27575929/ansi-escape-sequences-arent-printed-to-stdout-on-windows#answer-27575930"
    ].join(`\n${ " ".repeat(27) }`))
    .option("--raw-stdout", "Use raw stdout.")
    .option("--raw-stderr", "Use raw stderr.")
    .option("--debug", "Debug mode.")
    .option("--ready-timeout <ms>", `How long (in milliseconds) to wait for the SSH handshake to complete [${ defaultParams.readyTimeout }]`, defaultParams.readyTimeout)
    .option("-s, --sync [arguments]", [
        "sync localPath to remotePath. Can be repeated.",
        "arguments = localPath,remotePath[,recursive,options]"
    ].join(`\n${ " ".repeat(27) }`), collect, [])
    .parse(process.argv);

const {sync} = program;
if (!sync || sync.length === 0) {
    program.help();
    return;
}

const debug = function(msg) {
    logger.debug(msg);
};

const stdin = process.stdin;
const stdout = program.raw || program.rawStdout ? new SyncWriteStream(1, {
    autoClose: false
}) : process.stdout;

if (stdout !== process.stdout) {
    stdout.isTTY = process.stdout.isTTY;
}

const stderr = program.raw || program.rawStderr ? new SyncWriteStream(2, {
    autoClose: false
}) : process.stderr;

if (stderr !== process.stderr) {
    stderr.isTTY = process.stderr.isTTY;
}

const stdio = [stdin, stdout, stderr];

const remote = program.args && program.args.length !== 0 ? program.args[0].split("@") : [];

const connectOptions = {
    readyTimeout: program.readyTimeout,
    debug: program.debug ? debug : undefined,
    username: remote[0] ? decodeURIComponent(remote[0]) : defaultParams.user,
    host: remote[1] ? decodeURIComponent(remote.slice(1).join("@")) : defaultParams.host,
    port: program.port || defaultParams.port,
    password: program.password,
    agent: program.agent,
    privateKey: program.privateKey ? fs.readFileSync(program.privateKey) : undefined,
    passphrase: program.passphrase,
    stdio
};

if (program.raw) {
    stdout.write("\n");
}

sync.forEach((args, index) => {
    let pos = 0;
    let lastIndex = -1;
    let i, arg;

    const syncArgs = [];
    sync[index] = syncArgs;

    while (pos !== 4 && i !== -1) {
        i = args.indexOf(",", lastIndex + 1);
        arg = args.slice(lastIndex + 1, pos === 3 || i === -1 ? args.length : i);
        lastIndex = i;

        switch (pos) {
            case 0:
                syncArgs[pos] = decodeURIComponent(arg); // localPath
                break;
            case 1:
                syncArgs[pos] = decodeURIComponent(arg); // remotePath
                break;
            case 2:
                syncArgs[pos] = /^(?:true|t|1)$/i.test(arg); // recursive
                break;
            default:
                syncArgs[pos] = JSON.parse(arg);
        }

        pos++;
    }
});

connect(connectOptions, (err, client) => {
    let hasError = false;

    if (err) {
        stderr.write(`${ err }\n`);
        process.exit(1);
    }

    client.on("end", () => {
        if (hasError) {
            process.exit(1);
        }

        // hack to make sure stdin do not prevent process from exiting subshell
        stdin.resume();
        process.nextTick(() => {
            stdin.pause();
        });
    });

    const next = err => {
        if (err) {
            hasError = true;
            stderr.write(`${ err }\n`);
        }

        client.end();
    };

    client.sftp((err, sftp) => {
        if (err) {
            next(err);
            return;
        }

        eachSeries(sync, (args, next) => {
            const opts = args[args.length - 1];
            const download = opts !== null && typeof opts === "object" ? opts.protocol === protocols.DOWNLOAD : false;
            logger.info(args);
            upload(download ? sftp : fs, download ? fs : sftp, args, {
                stdio,
                logger
            }, next);
        }, next);
    });
});
