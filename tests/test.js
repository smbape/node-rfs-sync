/* eslint-env node, mocha */

const fs = require("fs");
const localSysPath = require("path");
const eachOfLimit = require("async/eachOfLimit");
const waterfall = require("async/waterfall");
const {explore} = require("fs-explorer");
const {Client} = require("ssh2");
const {Semaphore} = require("sem-lib");
const {assert} = require("chai");
const micromatch = require("micromatch");
const defaultsDeep = require("lodash/defaultsDeep");

const {
    limitRetry,
    isMkdirBusy,
    normalizeExploreFiles,
    rimraf,
    STATUS_CODE,
} = require("../lib/utils");

const {upload} = require("../");

const isWin32 = process.platform === "win32";
const platform = isWin32 ? "Windows" : "Linux";
const rwinsep = /^\/?\w+:(?:[/\\]|$)/;
const {posix, win32} = localSysPath;

const RETRY_TIMES = 3;
const RETRY_WAIT = 100;

const remoteDirSrc = ".FS_EXCHANGER_TEST_SRC";
const remoteDirDst = ".FS_EXCHANGER_TEST_DST";

const localDirSrc = localSysPath.join(__dirname, remoteDirSrc);
const localDirDst = localSysPath.join(__dirname, remoteDirDst);

const configs = {
    local: {
        name: `${ platform } local`,
        src: localDirSrc,
        dst: localDirDst,
    }
};

const populateTree = (tree, depth, filesLen) => {
    if (depth === 0) {
        return tree;
    }

    let file, dir, stats, name;

    for (dir = 0; dir < filesLen; dir++) {
        name = tree.name ? `${ tree.name }.${ dir + 1 }` : `dir-${ dir + 1 }`;
        if (name[0] !== ".") {
            name = `.${ name }`;
        }

        stats = {
            name,
            isDirectory: true,
            files: {}
        };

        tree.files[name] = stats;

        populateTree(stats, depth - 1, filesLen);
    }

    for (dir = 0; dir < filesLen; dir++) {
        name = tree.name ? `${ tree.name }.${ dir + 1 }` : `dir-${ dir + 1 }`;
        if (name[0] === ".") {
            name = name.slice(1);
        }

        stats = {
            name,
            isDirectory: true,
            files: {}
        };

        tree.files[name] = stats;

        populateTree(stats, depth - 1, filesLen);
    }

    for (file = 0; file < filesLen; file++) {
        name = tree.name ? `${ tree.name.replace("dir-", "file-") }.${ file + 1 }` : `file-${ file + 1 }`;
        if (name[0] !== ".") {
            name = `.${ name }`;
        }

        tree.files[name] = {
            name,
            isDirectory: false
        };
    }

    for (file = 0; file < filesLen; file++) {
        name = tree.name ? `${ tree.name.replace("dir-", "file-") }.${ file + 1 }` : `file-${ file + 1 }`;
        if (name[0] === ".") {
            name = name.slice(1);
        }

        tree.files[name] = {
            name,
            isDirectory: false
        };
    }

    return tree;
};

const constraintTree = (ret, tree, mindepth, maxdepth) => {
    if (mindepth == null && maxdepth == null) {
        return tree;
    }

    if (!tree.isDirectory) {
        if (mindepth === 0) {
            Object.assign(ret, tree);
        }
        return ret;
    }

    Object.assign(ret, tree, {
        files: {}
    });

    if (maxdepth === 0) {
        return ret;
    }

    if (mindepth !== 0) {
        mindepth--;
    }

    if (maxdepth > 0) {
        maxdepth--;
    }

    Object.keys(tree.files).forEach(name => {
        const retFile = {};
        ret.files[name] = retFile;
        constraintTree(retFile, tree.files[name], mindepth, maxdepth);
        if (Object.keys(retFile).length === 0) {
            delete ret.files[name];
        }
    });

    return ret;
};

const removeEmptyDirs = (ret, tree) => {
    if (!tree.isDirectory) {
        Object.assign(ret, tree);
        return ret;
    }

    const names = Object.keys(tree.files);
    if (names.length === 0) {
        return ret;
    }

    Object.assign(ret, tree, {
        files: {}
    });

    names.forEach(name => {
        const retFile = {};
        ret.files[name] = retFile;
        removeEmptyDirs(retFile, tree.files[name]);
        if (Object.keys(retFile).length === 0) {
            delete ret.files[name];
        }
    });

    return ret;
};

const applyFilter = (ret, tree, filter, sysPath, parentPath) => {
    let {name} = tree;

    if (parentPath) {
        name = name ? parentPath + sysPath.sep + name : parentPath;
    }

    if (name.length !== 0 && !filter(name)) {
        return ret;
    }

    if (!tree.isDirectory) {
        Object.assign(ret, tree);
        return ret;
    }

    Object.assign(ret, tree, {
        files: {}
    });

    Object.keys(tree.files).forEach(_name => {
        const retFile = {};
        ret.files[_name] = retFile;
        applyFilter(retFile, tree.files[_name], filter, sysPath, _name);
        if (Object.keys(retFile).length === 0) {
            delete ret.files[_name];
        }
    });

    return ret;
};

const applyFileFilter = (ret, tree, filter, sysPath, parentPath) => {
    let {name} = tree;

    if (parentPath) {
        name = name ? parentPath + sysPath.sep + name : parentPath;
    }

    if (!tree.isDirectory && name.length !== 0 && !filter(name)) {
        return ret;
    }

    if (!tree.isDirectory) {
        Object.assign(ret, tree);
        return ret;
    }

    Object.assign(ret, tree, {
        files: {}
    });

    Object.keys(tree.files).forEach(_name => {
        const retFile = {};
        ret.files[_name] = retFile;
        applyFileFilter(retFile, tree.files[_name], filter, sysPath, _name);
        if (Object.keys(retFile).length === 0) {
            delete ret.files[_name];
        }
    });

    return ret;
};

const applyDirFilter = (ret, tree, filter, sysPath, parentPath) => {
    let {name} = tree;

    if (parentPath) {
        name = name ? parentPath + sysPath.sep + name : parentPath;
    }

    if (tree.isDirectory && name.length !== 0 && !filter(name)) {
        return ret;
    }

    if (!tree.isDirectory) {
        Object.assign(ret, tree);
        return ret;
    }

    Object.assign(ret, tree, {
        files: {}
    });

    Object.keys(tree.files).forEach(_name => {
        const retFile = {};
        ret.files[_name] = retFile;
        applyDirFilter(retFile, tree.files[_name], filter, sysPath, _name);
        if (Object.keys(retFile).length === 0) {
            delete ret.files[_name];
        }
    });

    return ret;
};

const createTree = (config, rootDir, tree, cb) => {
    const {fs: sysFs, path: sysPath, scheduler} = config;

    const start = tree.name ? sysPath.join(rootDir, tree.name) : rootDir;
    // console.log(start);

    if (!tree.isDirectory) {
        const writable = sysFs.createWriteStream(start);
        writable.on("error", cb);
        writable.on("finish", cb);
        writable.write("text");
        writable.end();
        return;
    }

    limitRetry(isMkdirBusy, RETRY_TIMES, RETRY_WAIT, sysFs.mkdir.bind(sysFs), start, err => {
        if (err) {
            if (err.code !== "EEXIST" && err.code !== STATUS_CODE.FAILURE) {
                cb(err);
                return;
            }
            err = null;
        }

        const {files} = tree;

        if (!files || Object.keys(files).length === 0) {
            cb();
            return;
        }

        const shouldGive = scheduler.getNumTokens() !== scheduler.getCapacity();

        // deeper files have lower priority
        scheduler.schedule(files, start.split(sysPath.sep).length, (file, key, next) => {
            createTree(config, start, file, next);
        }, err => {
            // take the given token back
            // so that it will be re-given by the scheduler
            if (shouldGive) {
                scheduler.semTake({
                    priority: Number.NEGATIVE_INFINITY,
                    onTake: () => {
                        scheduler.setCapacity(scheduler.getCapacity() - 1);
                    }
                });
            }

            cb(err);
        });

        // give the taken token for this task back
        // so that children exploration does not get stuck
        if (shouldGive) {
            scheduler.setCapacity(scheduler.getCapacity() + 1);
            scheduler.semGive();
        }
    });
};

const exploreTree = ({fs: sysFs, path: sysPath}, rootDir, cb) => {
    const tree = {};
    const rootDirLen = rootDir.length + 1;

    const addElement = (path, el) => {
        const parts = path.slice(rootDirLen).split(sysPath.sep);
        const index = parts.length - 1;

        let curr = tree;

        for (let i = 0; i < index; i++) {
            curr = curr.files[parts[i]];
        }

        const name = parts[index];
        el.name = name;
        curr.files[name] = el;
    };

    explore(rootDir, (path, stats, next) => {
        addElement(path, {
            isDirectory: false
        });

        next();
    }, (path, stats, files, state, next) => {
        if (state === "begin") {
            normalizeExploreFiles(files);

            if (path === rootDir) {
                tree.name = "";
                tree.isDirectory = true;
                tree.files = {};
                next();
                return;
            }

            addElement(path, {
                isDirectory: true,
                files: {}
            });
        }
        next();
    }, {
        fs: sysFs,
        path: sysPath,
        limit: 64
    }, err => {
        cb(err, tree);
    });
};

const rimrafSys = (config, files, cb) => {
    eachOfLimit(files, 1, (file, i, next) => {
        rimraf(file, config, err => {
            if (err && (err.code === "ENOENT" || err.code === STATUS_CODE.NO_SUCH_FILE)) {
                err = null;
            }
            next(err);
        });
    }, cb);
};

const MAX_DEPTH = 2;
const FILES_LEN = 3;

const rootTree = populateTree({
    name: "",
    isDirectory: true,
    files: {}
}, MAX_DEPTH, FILES_LEN);

const rootTreeNoDot = JSON.parse(JSON.stringify(rootTree, (key, value) => {
    return key[0] === "." ? undefined : value;
}));

const EXCHANGE_TIMEOUT = 5 * 60 * 1000;

describe("exchange", () => {
    before(function(cb) {
        this.timeout(EXCHANGE_TIMEOUT); // eslint-disable-line no-invalid-this

        eachOfLimit(configs, Object.keys(configs).length, (config, key, next) => {
            // some HDD disk are extremly slow with parallel write
            config.scheduler = new Semaphore(1, true, 0, true);

            if (key === "local") {
                config.fs = fs;

                waterfall([
                    next => {
                        fs.realpath(".", next);
                    },

                    (cwd, next) => {
                        config.path = rwinsep.test(cwd) ? win32 : posix;
                        rimrafSys(config, [localDirSrc, localDirDst], next);
                    }
                ], next);
                return;
            }

            const client = new Client();
            config.client = client;

            waterfall([
                next => {
                    client.on("error", next);

                    client.on("ready", () => {
                        client.removeListener("error", next);
                        next();
                    });

                    client.connect(config);
                },

                next => {
                    client.sftp(next);
                },

                (sftp, next) => {
                    config.fs = sftp;
                    config.fs.realpath(".", next);
                },

                (cwd, next) => {
                    config.path = rwinsep.test(cwd) ? win32 : posix;
                    rimrafSys(config, [remoteDirSrc, remoteDirDst], next);
                }
            ], next);
        }, cb);
    });

    after(function(cb) {
        this.timeout(EXCHANGE_TIMEOUT); // eslint-disable-line no-invalid-this

        const disconnect = client => {
            // console.log("      disconnecting", key);
            client.on("error", err => {
                if (err.code !== "ECONNRESET") {
                    throw err;
                }
                // console.error(key, err);
            });
            client.end();
        };

        eachOfLimit(configs, Object.keys(configs).length, (config, key, next) => {
            if (key === "local") {
                next();
                return;
            }

            const {client} = config;

            if (client) {
                disconnect(client);
            }

            next();
        }, cb);
    });

    const addTest = (title, srcconfig, dstconfig, src, dst, mkdir, options) => {
        it(title, function(cb) {
            this.timeout(5000); // eslint-disable-line no-invalid-this,no-magic-numbers

            const {fs: srcFs, path: srcPath} = srcconfig;
            const {fs: dstFs, path: dstPath} = dstconfig;

            const {
                filter: _filter,
                files: _files,
                dirs: _dirs,
                dot,
                mindepth,
                maxdepth,
                emptyDirs,
                strip
            } = options;

            const recursive = true;
            const explored = strip ? dst : dstPath.join(dst, srcPath.basename(src));

            let expected = dot ? rootTree : rootTreeNoDot;
            expected = constraintTree({}, expected, mindepth, maxdepth);
            if (emptyDirs === false) {
                expected = removeEmptyDirs({}, expected);
            }

            let filter = null;
            let ffiles = null;
            let dirs = null;

            if (Array.isArray(_filter) || typeof _filter === "string") {
                filter = micromatch.matcher(Array.isArray(_filter) ? _filter : [_filter], {
                    dot
                });

                expected = applyFilter({}, expected, filter, srcPath);
            }

            if (Array.isArray(_files) || typeof _files === "string") {
                ffiles = micromatch.matcher(Array.isArray(_files) ? _files : [_files], {
                    dot
                });

                expected = applyFileFilter({}, expected, ffiles, srcPath);
            }

            if (Array.isArray(_dirs) || typeof _dirs === "string") {
                dirs = micromatch.matcher(Array.isArray(_dirs) ? _dirs : [_dirs], {
                    dot
                });

                expected = applyDirFilter({}, expected, dirs, srcPath);
            }

            waterfall([
                next => {
                    if (mkdir) {
                        limitRetry(isMkdirBusy, RETRY_TIMES, RETRY_WAIT, dstFs.mkdir.bind(dstFs), dst, next);
                    } else {
                        next();
                    }
                },

                next => {
                    upload(srcFs, dstFs, [src, dst, recursive], options, next);
                },

                next => {
                    exploreTree(dstconfig, explored, next);
                },

                (tree, next) => {
                    try {
                        assert.deepEqual(tree, expected);
                        next();
                    } catch (err) {
                        next(err);
                    }
                }
            ], cb);
        });
    };

    const addTestSuite = (srckey, dstkey) => {
        const srcconfig = configs[srckey];
        const dstconfig = configs[dstkey];
        const {name: srcname, src} = srcconfig;
        const {name: dstname, dst} = dstconfig;

        describe(`exchange ${ srcname }, ${ dstname }`, function() {
            this.timeout(EXCHANGE_TIMEOUT); // eslint-disable-line no-invalid-this

            before(cb => {
                createTree(srcconfig, src, rootTree, cb);
            });

            beforeEach(cb => {
                rimrafSys(dstconfig, [dst], cb);
            });

            after(cb => {
                waterfall([
                    next => {
                        rimrafSys(srcconfig, [src], next);
                    },
                    next => {
                        rimrafSys(dstconfig, [dst], next);
                    },
                ], cb);
            });

            it("should not exchange when destination does not exist with recursive", cb => {
                const {fs: localFs} = srcconfig;
                const {fs: remoteFs, path: remoteSysPath} = dstconfig;

                upload(localFs, remoteFs, [src, remoteSysPath.join(dst, "x"), true], err => {
                    try {
                        assert.instanceOf(err, Error);
                        assert.strictEqual(err.code === "ENOENT" || err.code === STATUS_CODE.NO_SUCH_FILE, true, "Expect ENOENT code");
                        cb();
                    } catch (err) {
                        cb(err);
                    }
                });
            });

            it("should not exchange when destination does not exist without recursive", cb => {
                const {fs: localFs} = srcconfig;
                const {fs: remoteFs} = dstconfig;

                upload(localFs, remoteFs, [src, dst, false], err => {
                    try {
                        assert.instanceOf(err, Error);
                        assert.strictEqual(err.code === "ENOENT" || err.code === STATUS_CODE.NO_SUCH_FILE, true, "Expect ENOENT code");
                        cb();
                    } catch (err) {
                        cb(err);
                    }
                });
            });

            it("should not exchange source directory without recursive", cb => {
                const {fs: localFs} = srcconfig;
                const {fs: remoteFs} = dstconfig;

                waterfall([
                    next => {
                        limitRetry(isMkdirBusy, RETRY_TIMES, RETRY_WAIT, remoteFs.mkdir.bind(remoteFs), dst, next);
                    },

                    next => {
                        upload(localFs, remoteFs, [src, dst], next);
                    }
                ], err => {
                    try {
                        assert.instanceOf(err, Error);
                        assert.strictEqual(err.code, "RECURSIVE");
                        cb();
                    } catch (err) {
                        cb(err);
                    }
                });
            });

            it("should not exchange source directory without recursive with strip", cb => {
                const {fs: localFs} = srcconfig;
                const {fs: remoteFs} = dstconfig;

                waterfall([
                    next => {
                        limitRetry(isMkdirBusy, RETRY_TIMES, RETRY_WAIT, remoteFs.mkdir.bind(remoteFs), dst, next);
                    },

                    next => {
                        upload(localFs, remoteFs, [src, dst], { strip: true }, next);
                    }
                ], err => {
                    try {
                        assert.instanceOf(err, Error);
                        assert.strictEqual(err.code, "RECURSIVE");
                        cb();
                    } catch (err) {
                        cb(err);
                    }
                });
            });

            it("should mirror", cb => {
                const {fs: localFs} = srcconfig;
                const {fs: remoteFs} = dstconfig;

                const options = {
                    dot: true,
                    strip: true,
                    delete: true
                };

                const rootTreeWithJunk = JSON.parse(JSON.stringify(rootTree).replace(/\.(file|dir)-/g, (match, item) => `junk-${ item }-`));

                waterfall([
                    next => {
                        createTree(dstconfig, dst, rootTreeWithJunk, next);
                    },

                    next => {
                        upload(localFs, remoteFs, [src, dst, true], options, err => {
                            try {
                                assert.strictEqual(err.code === "ENOTEMPTY" || err.code === STATUS_CODE.FAILURE, true, "Expect ENOTEMPTY code");
                                err = null;
                            } catch (_err) {
                                err = _err;
                            }
                            next(err);
                        });
                    },

                    next => {
                        options.force = true;
                        upload(localFs, remoteFs, [src, dst, true], options, next);
                    },

                    next => {
                        exploreTree(dstconfig, dst, next);
                    },

                    (tree, next) => {
                        try {
                            assert.deepEqual(tree, rootTree);
                            next();
                        } catch (err) {
                            next(err);
                        }
                    }
                ], cb);
            });

            it("should not mirror", cb => {
                const {fs: localFs} = srcconfig;
                const {fs: remoteFs} = dstconfig;

                const options = {
                    dot: true,
                    strip: true
                };

                const rootTreeWithJunk = JSON.parse(JSON.stringify(rootTree).replace(/\.(file|dir)-/g, (match, item) => `junk-${ item }-`));

                waterfall([
                    next => {
                        createTree(dstconfig, dst, rootTreeWithJunk, next);
                    },

                    next => {
                        upload(localFs, remoteFs, [src, dst, true], options, next);
                    },

                    next => {
                        exploreTree(dstconfig, dst, next);
                    },

                    (tree, next) => {
                        try {
                            assert.deepEqual(tree, defaultsDeep({}, rootTree, rootTreeWithJunk));
                            next();
                        } catch (err) {
                            next(err);
                        }
                    }
                ], cb);
            });

            [true, false].forEach(dot => {
                for (let mindepth = 0; mindepth <= MAX_DEPTH; mindepth++) {
                    for (let maxdepth = mindepth === 0 ? 1 : mindepth; maxdepth <= MAX_DEPTH; maxdepth++) {
                        [true, false].forEach(emptyDirs => {
                            [true, false].forEach(strip => {
                                [false, "**/*-2*", "**/file-1*", "**/dir-1*"].forEach(filter => {
                                    [false, "**/*-3", "**/file-3*"].forEach(files => {
                                        [false, "**/*-3", "**/dir-3*"].forEach(dirs => { // eslint-disable-line max-nested-callbacks
                                            const options = {
                                                dot,
                                                mindepth,
                                                maxdepth,
                                                emptyDirs,
                                                strip,
                                                filter,
                                                files,
                                                dirs,
                                            };

                                            const title = `should exchange ${ JSON.stringify(options) }`;

                                            addTest(title, srcconfig, dstconfig, src, dst, true, options);

                                            if (!strip) {
                                                addTest(`${ title } when not exists`, srcconfig, dstconfig, src, dst, false, options);
                                            }
                                        });
                                    });
                                });
                            });
                        });
                    }
                }
            });

            // TODO : force, ignoreExisting, existing, ignoreTimes, mode, explore
        });
    };

    const DEFAULT_SSH_PORT = 22;

    ["linux", "windows"].forEach(name => {
        const uname = name.toUpperCase();
        const cname = name[0].toUpperCase() + name.slice(1);

        if (process.env[`${ uname }_SSH_HOST`]) {
            configs[`${ name }1`] = {
                name: `${ cname } 1 remote`,
                src: remoteDirSrc,
                dst: remoteDirDst,
                host: process.env[`${ uname }_SSH_HOST`],
                port: process.env[`${ uname }_SSH_PORT`] ? parseInt(process.env[`${ uname }_SSH_PORT`], 10) : DEFAULT_SSH_PORT,
                username: process.env[`${ uname }_SSH_USERNAME`],
                agent: process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "pageant" : undefined)
            };

            configs[`${ name }2`] = Object.assign({}, configs[`${ name }1`], {
                name: `${ cname } 2 remote`,
            });
        }

        if (process.env[`${ uname }_SSH_HOST_1`]) {
            configs[`${ name }1`] = {
                name: `${ cname } 1 remote`,
                src: remoteDirSrc,
                dst: remoteDirDst,
                host: process.env[`${ uname }_SSH_HOST_1`],
                port: process.env[`${ uname }_SSH_PORT_1`] ? parseInt(process.env[`${ uname }_SSH_PORT_1`], 10) : DEFAULT_SSH_PORT,
                username: process.env[`${ uname }_SSH_USERNAME_1`],
                agent: process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "pageant" : undefined)
            };

            if (!process.env[`${ uname }_SSH_HOST_2`]) {
                configs[`${ name }2`] = Object.assign({}, configs[`${ name }1`], {
                    name: `${ cname } 2 remote`,
                });
            }
        }

        if (process.env[`${ uname }_SSH_HOST_2`]) {
            configs[`${ name }2`] = {
                name: `${ cname } 2 remote`,
                src: remoteDirSrc,
                dst: remoteDirDst,
                host: process.env[`${ uname }_SSH_HOST_2`],
                port: process.env[`${ uname }_SSH_PORT_2`] ? parseInt(process.env[`${ uname }_SSH_PORT_2`], 10) : DEFAULT_SSH_PORT,
                username: process.env[`${ uname }_SSH_USERNAME_2`],
                agent: process.env.SSH_AUTH_SOCK || (process.platform === "win32" ? "pageant" : undefined)
            };

            if (!process.env[`${ uname }_SSH_HOST_1`]) {
                configs[`${ name }1`] = Object.assign({}, configs[`${ name }2`], {
                    name: `${ cname } 1 remote`,
                });
            }
        }
    });

    addTestSuite("local", "local");

    if (configs.linux1) {
        addTestSuite("linux1", "linux2");
        addTestSuite("linux1", "local");
        addTestSuite("local", "linux1");

        if (configs.windows1) {
            addTestSuite("linux1", "windows1");
            addTestSuite("windows1", "linux1");
        }
    }

    if (configs.windows1) {
        addTestSuite("local", "windows1");
        addTestSuite("windows1", "local");
        addTestSuite("windows1", "windows2");
    }
});
