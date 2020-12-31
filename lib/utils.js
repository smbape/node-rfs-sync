const cp = require("child_process");
const eachOfLimit = require("async/eachOfLimit");
const {explore} = require("fs-explorer");

const FULL_ACCESS = 0b111111111;
const RETRY_TIMES = 3;
const RETRY_WAIT = 100;

const REGULAR_DIRECTORY_MODE_MASK = conventModeToInt("rwxrwxr-x");
const REGULAR_FILE_MODE_MASK = conventModeToInt("rwxrwxr-x");
const HIDDEN_DIRECTORY_MODE_MASK = conventModeToInt("rwxr-xr-x");
const HIDDEN_FILE_MODE_MASK = conventModeToInt("rwxr-xr-x");

// from const {SFTPStream: {STATUS_CODE}} = require("ssh2-streams");
// copied to avoid a dependency to ssh2-streams
const STATUS_CODE = {
    OK: 0,
    EOF: 1,
    NO_SUCH_FILE: 2,
    PERMISSION_DENIED: 3,
    FAILURE: 4,
    BAD_MESSAGE: 5,
    NO_CONNECTION: 6,
    CONNECTION_LOST: 7,
    OP_UNSUPPORTED: 8
};

const limitRetry = (test, limit, delay, fn, ...args) => {
    const last = args.length - 1;
    const cb = args[last];
    const slimit = limit;

    let started = false;
    let lastResult = [];
    let lastError;

    const flimit = err => {
        if (test(err)) {
            return --limit === 0;
        }
        return true;
    };

    const iterable = {
        [Symbol.iterator]: () => {
            return {
                next: () => {
                    return {
                        value: null,
                        done: started && (!lastError || flimit(lastError))
                    };
                }
            };
        }
    };

    eachOfLimit(iterable, 1, (value, key, next) => {
        const shouldDelay = delay > 0 && started;
        started = true;

        args[last] = (err, ...res) => {
            lastError = err;
            lastResult = res;
            next();
        };

        if (shouldDelay) {
            setTimeout(() => {
                fn(...args);
            }, delay * (slimit - limit));
        } else {
            fn(...args);
        }
    }, err => {
        cb(lastError, ...lastResult);
    });
};

const isBusy = err => {
    return err.code === "EBUSY" || err.code === "ENOTEMPTY" || err.code === "EPERM";
};

const isMkdirBusy = err => {
    return err.code === "EBUSY" || err.code === "EPERM";
};

const normalizeExploreFiles = files => {
    // sftp.readdir returns a list of objects instead of a list of string as expected by fs-explorer
    // transform the list of object files into a list of string
    files.forEach((file, i) => {
        if (file !== null && typeof file === "object" && typeof file.filename === "string") {
            files[i] = file.filename;
        }
    });
};

const assertPathExists = (path, {fs: sysFs, hasCygpath}, cb) => {
    sysFs.stat(path, (err, stats) => {
        if (!err || !hasCygpath) {
            cb(err, path, stats);
            return;
        }

        cp.exec(`cygpath -w '${ path }'`, (err, stdout, stderr) => {
            if (err) {
                cb(new Error(`Cannot stat "${ path }: ${ err.message }"`));
                return;
            }

            const cygpath = stdout.toString().replace(/[\r\n]/g, "");
            sysFs.stat(cygpath, (err, cygstats) => {
                cb(err, cygpath, cygstats);
            });
        });
    });
};

const rimraf = (start, {fs: sysFs, path: sysPath, ignoreEmpty, logger, silent}, cb) => {
    explore(start, (path, stats, next) => {
        if (!silent && logger) {
            logger.debug(`deleting file ${ path }`);
        }
        limitRetry(isBusy, RETRY_TIMES, RETRY_WAIT, sysFs.unlink.bind(sysFs), path, next);
    }, (path, stats, files, state, next) => {
        if (state === "end") {
            if (!silent && logger) {
                logger.debug(`deleting folder ${ path }`);
            }
            limitRetry(isBusy, RETRY_TIMES, RETRY_WAIT, sysFs.rmdir.bind(sysFs), path, next);
            return;
        }

        if (state === "begin") {
            normalizeExploreFiles(files);
        }

        next(null, ignoreEmpty);
    }, {
        fs: sysFs,
        path: sysPath,
        limit: 1 // some HDD disk are extremly slow with parallel write
    }, cb);
};

function conventModeToInt(str) {
    if (typeof str === "number") {
        return str & FULL_ACCESS;
    }

    if (typeof str !== "string") {
        throw new TypeError(`Invalid permission '${ str }'`);
    }

    if (/^[0-7]+$/.test(str)) {
        return parseInt(str, 8) & FULL_ACCESS;
    }

    if (str.length !== 9) { // eslint-disable-line no-magic-numbers
        throw new TypeError(`Invalid permission string '${ str }'`);
    }

    let n = FULL_ACCESS;

    for (let i = 0, ch, mask, pos; i < 9; i++) { // eslint-disable-line no-magic-numbers
        ch = str[i];
        pos = 8 - i;

        if (ch === "-") {
            // clear bit
            mask = 1 << pos; // gets the ith bit
            n &= ~mask;
            continue;
        }

        switch (pos % 3) { // eslint-disable-line no-magic-numbers
            case 2:
                if (ch !== "r") {
                    throw new TypeError(`Invalid character '${ ch }' at ${ i }`);
                }
                break;
            case 1:
                if (ch !== "w") {
                    throw new TypeError(`Invalid character '${ ch }' at ${ i }`);
                }
                break;
            default:
                if (ch !== "x") {
                    throw new TypeError(`Invalid character '${ ch }' at ${ i }`);
                }
        }
    }

    return n;
}

const getUmask = (localPath, localStats, remotePath, remoteStats, isDirectory, options) => {
    if (remoteStats && remoteStats.mode) {
        return undefined;
    }

    let mask;
    if (options.remoteRdot.test(remotePath)) {
        mask = isDirectory ? HIDDEN_DIRECTORY_MODE_MASK : HIDDEN_FILE_MODE_MASK;
    } else {
        mask = isDirectory ? REGULAR_DIRECTORY_MODE_MASK : REGULAR_FILE_MODE_MASK;
    }

    let {mode} = localStats;

    if (options.isWin32 && remotePath.endsWith(".sh") || isDirectory) {
        // on Windows execute bit is only set for (.EXE, .COM, .CMD, or .BAT)
        // https://software.intel.com/en-us/node/692823
        mode |= 0b001001001; // eslint-disable-line no-magic-numbers
    }

    return mode & mask;
};

const rstat = (fs, path, cb) => {
    fs.lstat(path, (err, lstats) => {
        if (err) {
            cb(err, null, path);
            return;
        }

        if (!lstats.isSymbolicLink()) {
            cb(null, lstats, path, lstats);
            return;
        }

        fs.realpath(path, (err, resolvedPath) => {
            if (err) {
                cb(err, null, path);
                return;
            }

            fs.lstat(resolvedPath, (err, stats) => {
                if (err) {
                    cb(err, null, resolvedPath);
                    return;
                }

                cb(err, stats, resolvedPath, lstats);
            });
        });
    });
};

Object.assign(exports, {
    STATUS_CODE,
    limitRetry,
    isMkdirBusy,
    normalizeExploreFiles,
    assertPathExists,
    rimraf,
    conventModeToInt,
    getUmask,
    rstat,
});
