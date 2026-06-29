/* Code 128 (Set B) → inline SVG — Node port of barcode.js (no DOM). */
"use strict";
var PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131","211412","211214","211232","2331112"
];
var START_B = 104, STOP = 106;

function encode(text) {
  var codes = [START_B], sum = START_B;
  for (var i = 0; i < text.length; i++) {
    var val = text.charCodeAt(i) - 32;
    if (val < 0 || val > 94) val = 0;
    codes.push(val); sum += val * (i + 1);
  }
  codes.push(sum % 103); codes.push(STOP);
  return codes;
}
function toSVG(text, opts) {
  opts = opts || {};
  var moduleW = opts.moduleWidth || 2, height = opts.height || 70;
  var codes = encode(String(text || "")), bars = [], x = 0;
  for (var c = 0; c < codes.length; c++) {
    var pat = PATTERNS[codes[c]], isBar = true;
    for (var k = 0; k < pat.length; k++) {
      var w = parseInt(pat[k], 10) * moduleW;
      if (isBar) bars.push('<rect x="' + x + '" y="0" width="' + w + '" height="' + height + '"/>');
      x += w; isBar = !isBar;
    }
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + x + '" height="' + height + '" viewBox="0 0 ' + x + ' ' + height + '">' +
    '<rect x="0" y="0" width="' + x + '" height="' + height + '" fill="#fff"/><g fill="#000">' + bars.join("") + '</g></svg>';
}
module.exports = { toSVG: toSVG, encode: encode };
