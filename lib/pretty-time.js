/*!
 * pretty-time <https://github.com/jonschlinkert/pretty-time>
 *
 * Copyright (c) 2015-2018, present, Jon Schlinkert.
 * Released under the MIT License.
 */

const utils = {};

utils.nano = time => +time[0] * 1e9 + +time[1]; // eslint-disable-line no-magic-numbers

utils.scale = {
    w: 6048e11,
    d: 864e11,
    h: 36e11,
    m: 6e10,
    s: 1e9,
    ms: 1e6,
    μs: 1e3,
    ns: 1,
};

utils.regex = {
    w: /^(w((ee)?k)?s?)$/,
    d: /^(d(ay)?s?)$/,
    h: /^(h((ou)?r)?s?)$/,
    m: /^(min(ute)?s?|m)$/,
    s: /^((sec(ond)?)s?|s)$/,
    ms: /^(milli(second)?s?|ms)$/,
    μs: /^(micro(second)?s?|μs)$/,
    ns: /^(nano(second)?s?|ns?)$/,
};

utils.isSmallest = function(uom, unit) {
    return utils.regex[uom].test(unit);
};

utils.round = function(num, digits) {
    const n = Math.abs(num);
    return /[0-9]/.test(digits) ? n.toFixed(digits) : Math.round(n);
};

module.exports = (time, smallest, digits) => {
    const isNumber = /^[0-9]+$/.test(time);
    if (!isNumber && !Array.isArray(time)) {
        throw new TypeError("expected an array or number in nanoseconds");
    }
    if (Array.isArray(time) && time.length !== 2) {
        throw new TypeError("expected an array from process.hrtime()");
    }

    let num = isNumber ? time : utils.nano(time);
    let res = "";
    let prev;

    for (const uom of Object.keys(utils.scale)) {
        const step = utils.scale[uom];
        let inc = num / step;

        if (smallest && utils.isSmallest(uom, smallest)) {
            inc = utils.round(inc, digits);
            if (prev && (inc === (prev / step))) {
                --inc;
            }
            res += inc + uom;
            return res.trim();
        }

        if (inc < 1) {
            continue;
        }
        if (!smallest) {
            inc = utils.round(inc, digits);
            res += inc + uom;
            return res;
        }

        prev = step;

        inc = Math.floor(inc);
        num -= (inc * step);
        res += `${ inc + uom } `;
    }

    return res.trim();
};
