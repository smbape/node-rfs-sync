const micromatch = require("micromatch");
const {explore} = require("fs-explorer");
const {posix, win32} = require("path");
const eachOfLimit = require("async/eachOfLimit");
const eachSeries = require("async/eachSeries");
const series = require("async/series");
const waterfall = require("async/waterfall");
const log4js = require("@log4js-node/log4js-api");

const {
    STATUS_CODE,
    limitRetry,
    isMkdirBusy,
    assertPathExists,
    rimraf,
    conventModeToInt,
    normalizeExploreFiles,
    getUmask,
    rstat,
} = require("./lib/utils");

const pretty = require("./lib/pretty-time");

const hasCygpath = process.platform === "win32" && process.env.TERM === "cygwin";

const emptyFn = Function.prototype;
const rwinsep = /^\/?\w+:(?:[/\\]|$)/;

const rdotposix = /(?:^|[/])\.[^/]+$/;
const rdotwin32 = /(?:^|[\\])\.[^\\]+$/;

const RETRY_TIMES = 3;
const RETRY_WAIT = 100;
const DEFAULT_LIMIT = 64;

const {hasOwnProperty: hasProp} = Object.prototype;
const pick = (obj, props) => {
    const res = {};
    props.forEach(prop => {
        if (hasProp.call(obj, prop)) {
            res[prop] = obj[prop];
        }
    });
    return res;
};

const protocols = {
    DOWNLOAD: 1,
    COPY: 2,
    SSH2: 3,
    UPLOAD: 4,
};

exports.protocols = protocols;

const downloadProxy = (localFs, remoteFs) => {
    return new Proxy(remoteFs, {
        get(target, prop, receiver) {
            if (prop === "fastPut") {
                return function(localPath, remotePath, opts, cb) {
                    if (opts !== null && typeof opts === "object" && opts.stats) {
                        opts = Object.assign({}, opts, {
                            stats: null
                        });
                    }
                    localFs.fastGet(localPath, remotePath, opts, cb);
                };
            }

            if (prop === "setstat") {
                return function(path, stats, cb) {
                    const {atime, mtime} = stats !== null && typeof stats === "object" ? stats : {};
                    this.utimes(path, atime, mtime, cb); // eslint-disable-line no-invalid-this
                };
            }

            if (prop === "fsetstat") {
                return function(fd, stats, cb) {
                    const {atime, mtime} = stats !== null && typeof stats === "object" ? stats : {};
                    this.futimes(fd, atime, mtime, cb); // eslint-disable-line no-invalid-this
                };
            }

            return Reflect.get(...arguments);
        }
    });
};

const copyProxy = (localFs, remoteFs) => {
    return new Proxy(remoteFs, {
        get(target, prop, receiver) {
            if (prop === "fastPut") {
                return function(localPath, remotePath, opts, cb) {
                    this.copyFile(localPath, remotePath, 0, cb); // eslint-disable-line no-invalid-this
                };
            }

            if (prop === "setstat") {
                return function(path, stats, cb) {
                    const {atime, mtime} = stats !== null && typeof stats === "object" ? stats : {};
                    this.utimes(path, atime, mtime, cb); // eslint-disable-line no-invalid-this
                };
            }

            if (prop === "fsetstat") {
                return function(fd, stats, cb) {
                    const {atime, mtime} = stats !== null && typeof stats === "object" ? stats : {};
                    this.futimes(fd, atime, mtime, cb); // eslint-disable-line no-invalid-this
                };
            }

            return Reflect.get(...arguments);
        }
    });
};

const ssh2Proxy = (localFs, remoteFs) => {
    return new Proxy(remoteFs, {
        get(target, prop, receiver) {
            if (prop === "fastPut") {
                return function(localPath, remotePath, opts, cb) {
                    const readable = localFs.createReadStream(localPath, pick(opts, ["flags", "encoding", "handle", "mode", "autoClose", "start", "end"]));
                    const writable = remoteFs.createWriteStream(remotePath, pick(opts, ["flags", "encoding", "mode", "autoClose", "start"]));

                    const onerror = err => {
                        readable.removeListener("error", onerror);
                        writable.removeListener("error", onerror);
                        cb(err);
                    };

                    writable.on("error", onerror);
                    readable.on("error", onerror);
                    writable.on("finish", cb);

                    readable.pipe(writable);
                };
            }

            return Reflect.get(...arguments);
        }
    });
};

exports.upload = upload;
function upload(localFs, remoteFs, args, options, done) {
    if (arguments.length === 4) {
        if ("function" !== typeof options) {
            throw new TypeError(`Last argument should be a function. Given ${ typeof options }.`);
        }
        done = options;
        options = undefined;
    }

    if (!done) {
        done = emptyFn;
    }

    options = Object.assign({
        hasCygpath,
        dot: true,
        emptyDirs: true,
        existing: false,
        ignoreExisting: false,
        ignoreTimes: false,
        modifyWindow: 0,
        sizeOnly: false,
        logger: log4js.getLogger("rfs-sync"),
        state: {
            start: process.hrtime(),
            files: 0,
            folders: 0,
        }
    }, options);

    series([
        next => {
            localFs.realpath(".", (err, cwd) => {
                if (!err) {
                    if (rwinsep.test(cwd)) {
                        options.localSysPath = win32;
                        options.localRdot = rdotwin32;
                    } else {
                        options.localSysPath = posix;
                        options.localRdot = rdotposix;
                    }
                }
                next(err);
            });
        },

        next => {
            remoteFs.realpath(".", (err, cwd) => {
                if (!err) {
                    if (rwinsep.test(cwd)) {
                        options.remoteSysPath = win32;
                        options.remoteRdot = rdotwin32;
                    } else {
                        options.remoteSysPath = posix;
                        options.remoteRdot = rdotposix;
                    }
                }
                next(err);
            });
        },

        next => {
            if (!Array.isArray(args[0])) {
                args = [args];
            }

            eachSeries(args, ([localPath, remotePath, recursive, opts], next) => {
                if (recursive !== null && typeof recursive === "object") {
                    opts = recursive;
                    recursive = opts.recursive;
                }

                opts = Object.assign({
                    limit: DEFAULT_LIMIT
                }, options, opts);

                if (typeof opts.strip === "undefined" && localPath[localPath.length - 1] === opts.localSysPath.sep) {
                    opts.strip = true;
                    localPath = localPath.slice(0, -1);
                }

                let {protocol} = opts;
                delete opts.protocol;

                let _localFs, _remoteFs;

                if (protocol == null) {
                    if (typeof localFs.fastGet === "function" && typeof remoteFs.fastGet === "function") {
                        protocol = protocols.SSH2;
                    } else if (typeof localFs.copyFile === "function" && typeof remoteFs.copyFile === "function") {
                        protocol = protocols.COPY;
                    } else if (typeof localFs.fastGet === "function" && typeof remoteFs.utimes === "function") {
                        protocol = protocols.DOWNLOAD;
                    } else if (typeof remoteFs.fastPut === "function") {
                        protocol = protocols.UPLOAD;
                    }
                }

                if (protocol === protocols.DOWNLOAD) {
                    _localFs = localFs;
                    _remoteFs = downloadProxy(localFs, remoteFs);
                } else if (protocol === protocols.COPY) {
                    _localFs = localFs;
                    _remoteFs = copyProxy(localFs, remoteFs);
                } else if (protocol === protocols.SSH2) {
                    _localFs = localFs;
                    _remoteFs = ssh2Proxy(localFs, remoteFs);
                } else if (protocol === protocols.UPLOAD) {
                    _localFs = localFs;
                    _remoteFs = remoteFs;
                } else {
                    next(new TypeError("Invalid exchange protocol"));
                    return;
                }

                waterfall([
                    next => {
                        assertPathExists(localPath, {
                            fs: _localFs,
                            hasCygpath: protocol !== protocols.DOWNLOAD && opts.hasCygpath
                        }, next);
                    },

                    (_localPath, _localStats, next) => {
                        const { remoteSysPath } = opts;

                        assertPathExists(opts.strip ? remotePath : remoteSysPath.dirname(remotePath), {
                            fs: _remoteFs,
                            hasCygpath: protocol === protocols.DOWNLOAD && opts.hasCygpath
                        }, (err, _remotePath, _remoteStats) => {
                            next(err, _localPath, _localStats, _remotePath, _remoteStats);
                        });
                    },

                    (_localPath, _localStats, _remotePath, _remoteStats, next) => {
                        if (!opts.strip) {
                            const { remoteSysPath } = opts;
                            _remotePath = remoteSysPath.join(_remotePath, remoteSysPath.basename(remotePath));
                        }

                        if (!recursive || opts.strip || !_localStats.isDirectory()) {
                            next(null, _localPath, _localStats, _remotePath, _remoteStats);
                            return;
                        }

                        limitRetry(isMkdirBusy, RETRY_TIMES, RETRY_WAIT, _remoteFs.mkdir.bind(_remoteFs), _remotePath, {
                            mode: opts.mode
                        }, err => {
                            // In case of sftp, err.code === STATUS_CODE.FAILURE
                            // In case of fs, err.code === STATUS_CODE.EEXISTS
                            // Because FAILURE is a generic error, it is not possible to affirm that it is an EEXISTS error
                            // Therefore, I choose to ignore any mkdir error
                            // If the upload is not possible, another error will arise during _upload
                            next(null, _localPath, _localStats, _remotePath, _remoteStats);
                        });
                    },

                    (_localPath, _localStats, _remotePath, _remoteStats, next) => {
                        _upload(_localFs, _remoteFs, _localPath, _remotePath, recursive, opts, next);
                    }
                ], next);
            }, next);
        }
    ], (err, results) => {
        const {state} = options;
        if (!options.silent) {
            const {logger} = options;
            logger.info(`processed ${ state.files } files and ${ state.folders } folders (${ state.files + state.folders }) in ${ pretty(process.hrtime(state.start)) }`);
        }
        done(err);
    });
}

exports._upload = _upload;
function _upload(localFs, remoteFs, localPath, remotePath, recursive, options, done) {
    const { localSysPath, remoteSysPath } = options;

    const { basename: localBasename, sep: localSep } = localSysPath;
    const { sep: remoteSep } = remoteSysPath;
    let _localType;

    series([
        next => {
            rstat(localFs, localPath, (err, stats, _localPath) => {
                if (err) {
                    next(err);
                    return;
                }

                localPath = _localPath;
                _localType = stats.isDirectory() ? "directory" : "file";
                next(null, [stats, _localType]);
            });
        },

        next => {
            waterfall([
                next => {
                    rstat(remoteFs, remotePath, (err, remoteStats, resolvedPath, remoteLstats) => {
                        next(err && (err.code === STATUS_CODE.NO_SUCH_FILE || err.code === "ENOENT") ? null : err, err, remoteStats, resolvedPath, remoteLstats);
                    });
                },

                (remotePathErr, remoteStats_, resolvedPath_, remoteLstats_, next) => {
                    if (!options.strip || !remotePathErr || _localType !== "directory" || !recursive) {
                        next(null, remotePathErr, remoteStats_, resolvedPath_, remoteLstats_);
                        return;
                    }

                    limitRetry(isMkdirBusy, RETRY_TIMES, RETRY_WAIT, remoteFs.mkdir.bind(remoteFs), remotePath, {
                        mode: options.mode
                    }, err => {
                        if (err) {
                            next(err);
                            return;
                        }

                        rstat(remoteFs, remotePath, (err, remoteStats, resolvedPath, remoteLstats) => {
                            next(err, err, remoteStats, resolvedPath, remoteLstats);
                        });
                    });
                },

                (remotePathErr, remoteStats_, resolvedPath_, remoteLstats_, next) => {
                    if (options.strip) {
                        next(null, remoteStats_, remotePathErr ? null : remoteStats_.isDirectory() ? "directory" : "file");
                        return;
                    }

                    if (remotePathErr) {
                        next(remotePathErr);
                        return;
                    }

                    if (!remoteStats_.isDirectory()) {
                        next(null, remoteLstats_, "file");
                        return;
                    }

                    const localBase = localBasename(localPath);
                    remotePath += `${ remoteSep }${ localBase }`;

                    rstat(remoteFs, remotePath, (err, remoteStats, resolvedPath, remoteLstats) => {
                        if (err) {
                            next(err.code === STATUS_CODE.NO_SUCH_FILE || err.code === "ENOENT" ? null : err, remoteStats, null);
                            return;
                        }

                        next(null, remoteLstats, remoteStats.isDirectory() ? "directory" : "file");
                    });
                },

                (remoteStats, remoteType, next) => {
                    next(null, [remoteStats, remoteType]);
                }

            ], next);
        }
    ], (err, res) => {
        if (err) {
            done(err);
            return;
        }

        const [[localStats_, localType], [remoteStats_, remoteType]] = res;

        if (localType === "directory") {
            if (!recursive) {
                const err = new Error(`localPath '${ localPath }' is a directory. To upload a directory, use options.recursive = true.`);
                err.code = "RECURSIVE";
                done(err);
                return;
            }

            if (remoteType === "file") {
                done(new Error(`localPath '${ localPath }' is a directory and remotePath '${ remotePath }' is a file`));
                return;
            }
        } else if (localType === "file" && remoteType === "directory") {
            done(new Error(`localPath '${ localPath }' is a file and remotePath '${ remotePath }' is a directory`));
            return;
        }

        if (remoteType === "file") {
            if (localType === "directory") {
                done(new Error(`remotePath '${ remotePath }' is a file and localPath '${ localPath }' is a directory`));
                return;
            }
            uploadFile(remoteFs, localPath, localStats_, remotePath, remoteStats_, options, done);
            return;
        }

        const {
            logger,
            filter: _filter,
            files: _files,
            dirs: _dirs,
            mode,
            dot,
            mindepth,
            maxdepth,
            localRdot,
            emptyDirs,
            delete: _delete,
        } = options;

        const limit = isNaN(options.limit) || !isFinite(options.limit) ? DEFAULT_LIMIT : options.limit;

        let filter = null;
        let ffiles = null;
        let dirs = null;

        if (Array.isArray(_filter) || typeof _filter === "string" || _filter instanceof RegExp) {
            filter = _filter instanceof RegExp ? (entry => _filter.test(entry)) : micromatch.matcher(Array.isArray(_filter) ? _filter : [_filter], {
                dot
            });
        }

        if (Array.isArray(_files) || typeof _files === "string" || _files instanceof RegExp) {
            ffiles = _files instanceof RegExp ? (entry => _files.test(entry)) : micromatch.matcher(Array.isArray(_files) ? _files : [_files], {
                dot
            });
        }

        if (Array.isArray(_dirs) || typeof _dirs === "string" || _dirs instanceof RegExp) {
            dirs = _dirs instanceof RegExp ? (entry => _dirs.test(entry)) : micromatch.matcher(Array.isArray(_dirs) ? _dirs : [_dirs], {
                dot
            });
        }

        const baseIndex = localPath.length + 1;

        explore(localPath, (localFile, localStats, next) => {
            options.state.files++;

            const localBaseFile = localFile.slice(baseIndex);
            const fileparts = localBaseFile.split(localSep);

            if (mindepth > 0 && fileparts.length < mindepth) {
                next(null, false);
                return;
            }

            const remoteFile = localBaseFile.length === 0 ? remotePath : `${ remotePath }${ remoteSep }${ fileparts.join(remoteSep) }`;

            const patherr = validatePath(localFile, remoteFile, options);
            if (patherr) {
                next(patherr);
                return;
            }

            if (!dot && localRdot.test(localBaseFile)) {
                if (!options.silent) {
                    logger.trace("skip uploaded[dot]", localFile, "to", remoteFile);
                }
                next(null, false);
                return;
            }

            if (filter && !filter(localBaseFile)) {
                if (!options.silent) {
                    logger.trace("skip uploaded[filter]", localFile, "to", remoteFile);
                }
                next(null, false);
                return;
            }

            if (ffiles && !ffiles(localBaseFile)) {
                if (!options.silent) {
                    logger.trace("skip uploaded[file filter]", localFile, "to", remoteFile);
                }
                next(null, false);
                return;
            }

            rstat(remoteFs, remoteFile, (err, stats, resolvedPath, remoteStats) => {
                if (!err && remoteStats.isDirectory()) {
                    next(new Error(`'${ localFile }' is a file and '${ remoteFile }' is a directory.`));
                    return;
                }

                uploadFile(remoteFs, localFile, localStats, remoteFile, remoteStats, options, next);
            });
        }, (localDir, localStats, files, state, next) => {
            if (state !== "begin") {
                if (_delete && !files.skipped) {
                    remoteFs.readdir(files.remoteDir, (err, remoteFiles) => {
                        if (err) {
                            next(err);
                            return;
                        }

                        normalizeExploreFiles(remoteFiles);

                        eachOfLimit(remoteFiles, 1, (file, i, next) => {
                            if (files.indexOf(file) !== -1) {
                                next();
                            } else {
                                rimraf(remoteSysPath.join(files.remoteDir, file), {
                                    fs: remoteFs,
                                    path: remoteSysPath,
                                    ignoreEmpty: !options.force,
                                    logger,
                                    silent: options.silent
                                }, next);
                            }
                        }, next);
                    });
                } else {
                    next();
                }
                return;
            }

            options.state.folders++;

            normalizeExploreFiles(files);

            const localBaseDir = localDir.slice(baseIndex);

            const depth = localBaseDir.length === 0 ? 0 : localBaseDir.split(localSep).length;

            if (maxdepth >= 0 && depth > maxdepth) {
                files.skipped = true;
                next(null, true);
                return;
            }

            const remoteDir = localBaseDir.length === 0 ? remotePath : `${ remotePath }${ remoteSep }${ localBaseDir.split(localSep).join(remoteSep) }`;

            const patherr = validatePath(localDir, remoteDir, options);
            if (patherr) {
                next(patherr);
                return;
            }

            if (!dot && localRdot.test(localBaseDir)) {
                if (!options.silent) {
                    logger.trace("skip uploaded[dot]", localDir, "to", remoteDir);
                }
                files.skipped = true;
                next(null, true);
                return;
            }

            if (depth !== 0 && filter && !filter(localBaseDir)) {
                if (!options.silent) {
                    logger.trace("skip uploaded[filter]", localDir, "to", remoteDir);
                }
                files.skipped = true;
                next(null, true);
                return;
            }

            if (depth !== 0 && dirs && !dirs(localBaseDir)) {
                if (!options.silent) {
                    logger.trace("skip uploaded[directory filter]", localDir, "to", remoteDir);
                }
                files.skipped = true;
                next(null, true);
                return;
            }

            if (filter) {
                // early filter files since there will not be explored
                // thus avoiding unecessary cpu work
                const base = localBaseDir.length === 0 ? "" : localBaseDir + localSep;
                files.filter(file => {
                    const localBaseFile = base + file;
                    if (!dot && localRdot.test(localBaseFile) || !filter(localBaseFile)) {
                        if (!options.silent) {
                            logger.trace("skip uploaded[filter]", localDir + file, "to", remoteDir + file);
                        }
                        return false;
                    }
                    return true;
                }).forEach((file, i, arr) => {
                    if (i === 0) {
                        files.length = arr.length;
                    }
                    files[i] = file;
                });
            }

            if (maxdepth >= 0) {
                if (maxdepth === depth) {
                    // we reach the maxdepth, which means there is no deeper exploration
                    files.length = 0;
                } else if (!emptyDirs && ffiles && maxdepth - depth === 1) {
                    // Early filter files to avoiding unecessary cpu work.
                    // This is the deepest explored directory.
                    // Any directory will not be uploaded
                    // because we do not create empty directories.
                    // Therefore, it doesn't matter if we apply file filter to them
                    const base = localBaseDir.length === 0 ? "" : localBaseDir + localSep;
                    files.filter(file => {
                        const localBaseFile = base + file;
                        if (!dot && localRdot.test(localBaseFile) || filter !== null && !filter(localBaseFile)) {
                            if (!options.silent) {
                                logger.trace("skip uploaded[filter]", localDir + file, "to", remoteDir + file);
                            }
                            return false;
                        }
                        return true;
                    }).forEach((file, i, arr) => {
                        if (i === 0) {
                            files.length = arr.length;
                        }
                        files[i] = file;
                    });
                }
            }

            if (!emptyDirs && files.length === 0) {
                if (!options.silent) {
                    logger.trace("skip uploaded[empty dir]", localDir, "to", remoteDir);
                }
                files.skipped = true;
                next(null, true);
                return;
            }

            files.sort();
            files.remoteDir = remoteDir;

            remoteFs.stat(remoteDir, (err, remoteStats) => {
                if (!err) {
                    next();
                    return;
                }

                if (err.code !== STATUS_CODE.NO_SUCH_FILE && err.code !== "ENOENT") {
                    next(err);
                    return;
                }

                limitRetry(isMkdirBusy, RETRY_TIMES, RETRY_WAIT, remoteFs.mkdir.bind(remoteFs), remoteDir, {
                    mode: mode || getUmask(localDir, localStats, remoteDir, remoteStats, true, options)
                }, next);
            });
        }, Object.assign({
            followSymlink: false,
            limit,
        }, options.explore, {
            fs: localFs,
            path: localSysPath
        }), done);
    });
}

function uploadFile(remoteFs, localPath, localStats, remotePath, remoteStats, options, done) {
    const patherr = validatePath(localPath, remotePath, options);
    if (patherr) {
        done(patherr);
        return;
    }

    const {logger} = options;

    if (options.existing && !remoteStats) {
        if (!options.silent) {
            logger.trace("skip uploaded[existing]", localPath, "to", remotePath);
        }
        done(null, false);
        return;
    }

    if (options.ignoreExisting && remoteStats) {
        if (!options.silent) {
            logger.trace("skip uploaded[ignore-existing]", localPath, "to", remotePath);
        }
        done(null, false);
        return;
    }

    options = Object.assign({
        mode: getUmask(localPath, localStats, remotePath, remoteStats, false, options),
        stats: pick(localStats, ["atime", "mtime", "ctime", "birthtime"])
    }, options);

    const {stats: localStats_} = options;

    if (typeof localStats_.mtime === "number") {
        localStats_.mtime = new Date(localStats_.mtime * 1000);
    }

    if (remoteStats && localStats_.mtime instanceof Date) {
        const localMtime = localStats_.mtime.getTime() / 1000 >> 0;
        const remoteMtime = remoteStats.mtime instanceof Date ? remoteStats.mtime.getTime() / 1000 >> 0 : remoteStats.mtime;

        if (options.checkNew && localMtime <= remoteMtime) {
            if (!options.silent) {
                logger.trace("skip uploaded[new]", localPath, "to", remotePath);
            }
            done(null, false);
            return;
        }

        if (options.sizeOnly && localStats.size === remoteStats.size) {
            if (!options.silent) {
                logger.trace("skip uploaded[size]", localPath, "to", remotePath);
            }
            done(null, false);
            return;
        }

        if (!options.ignoreTimes && localStats.size === remoteStats.size) {
            let modified = localMtime !== remoteMtime;
            if (modified && options.modifyWindow > 0) {
                modified = Math.abs(localMtime - remoteMtime) > options.modifyWindow;
            }

            if (!modified) {
                if (!options.silent) {
                    logger.trace("skip uploaded[times and size]", localPath, "to", remotePath);
                }
                done(null, false);
                return;
            }
        }
    }

    _uploadFile(remoteFs, localPath, localStats, remotePath, remoteStats, options, done);
}

function _uploadFile(remoteFs, localPath, localStats, remotePath, remoteStats, options, cb) {
    const {logger} = options;

    if (options.mode) {
        options.mode = conventModeToInt(options.mode);
    }

    if (!options.silent) {
        logger.debug("uploading", localPath, "to", remotePath);
    }

    remoteFs.fastPut(localPath, remotePath, options, err => {
        if (err) {
            cb(err);
            return;
        }

        if (!options.silent) {
            logger.debug("uploaded", localPath, "to", remotePath);
        }

        // Always set stats to avoid any OS specificities
        // Needed by OpenSSH windows, files without a size, downloading
        remoteFs.setstat(remotePath, options.stats, err => {
            cb(err, true);
        });
    });
}

function validatePath(localPath, remotePath, options) {
    const { localSysPath: { sep: localSep }, remoteSysPath: { sep: remoteSep } } = options;
    if (localSep === remoteSep || !localPath.split(localSep).some(name => name.indexOf(remoteSep) !== -1)) {
        return null;
    }
    return new Error(`localPath '${ localPath }' Cannot be uploaded to remotePath '${ remotePath }' because ${ remoteSep } is an invalid character for path name`);
}
