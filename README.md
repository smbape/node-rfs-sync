# rfs-sync
Synchronize files between file systems

## usage with fs

```js
const fs = require("fs");
const {upload} = require("rfs-sync");
const srcFs = fs;
const dstFs = fs;
const src = "src";
const dst = "dst"
const recursive = true;
const options = {};
upload(srcFs, dstFs, [src, dst, recursive], options, err => {
    // Upload done
});
```

## usage with ssh2

```js
const fs = require("fs");
const {Client} = require("ssh2");
const {upload} = require("rfs-sync");
const client = new Client();

client.on("ready", () => {
    client.sftp((err, sftp) => {
        if (err) {
            throw err;
        }

        const srcFs = fs;
        const dstFs = sftp;
        const src = "src";
        const dst = "dst"
        const recursive = true;
        const options = {};
        upload(srcFs, dstFs, [src, dst, recursive], options, err => {
            // Upload done
        });
    });
});

client.connect({
    // host,
    // port,
    // username,
    // agent,
});

```

## recursive argument
If true, explore directories

## Options

### dot: Boolean, [= false]
If true, sync files and directories starting with '.'

### mindepth: Integer
In conjuction with recursive, do not sync files and directories with depth lower than mindepth

### maxdepth: Integer
In conjuction with recursive, do not sync files and directories with depth greater than maxdepth

### emptyDirs: Boolean, [= true]
If not true, do not sync empty directories

### existing: Boolean, [= false]
If not true, do not sync files that does not exist on dst

### ignoreExisting: Boolean, [= false]
If not true, do not sync files that exists on dst

### strip: Boolean, [= false]
In conjuction with recursive, if true, sync the content of src in dst.  
Otherwise, puts src in dst.

### fiter: RegExp|[micromatch pattern](https://www.npmjs.com/package/micromatch)
Do not sync files and directories not matching filter

### files: RegExp|[micromatch pattern](https://www.npmjs.com/package/micromatch)
Do not sync files not matching filter

### dirs: RegExp|[micromatch pattern](https://www.npmjs.com/package/micromatch)
Do not sync directories not matching filter

### concurrency: Integer, [= 64]
Number of concurrent reads when the file system is an sftp client

### chunkSize: Integer, [= 32768]
Size of each read in bytes when the file system is an sftp client

### step: function(Integer total_transferred, Integer chunk, Integer total)
Called every time a part of a file was transferred when the file system is an sftp client

### mode: Integer|String
Integer or string representing the file mode to set for the synced file
