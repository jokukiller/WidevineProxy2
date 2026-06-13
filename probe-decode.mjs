// Decode the get-otp key param (UTF-16BE hex) and the otp response.
const keyHex = '004200450068007a004300510042007200490067006f00700055004300350039005a00770055007700580079006f006c004c0031003800450063004600640051006400310042002f0066006d004e004c004b00670063003d';
const otpB64 = 'AUl7U1A9eV0qXSkvYFNlC34nL15adFIPfQwuKmNLLQY=';

// key param: hex -> bytes -> UTF-16BE string
const bytes = Buffer.from(keyHex, 'hex');
let utf16 = '';
for (let i = 0; i < bytes.length; i += 2) utf16 += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
console.log('get-otp key param decoded (UTF-16BE):', utf16, ' len=', utf16.length);
try {
  const inner = Buffer.from(utf16, 'base64');
  console.log('  that base64 -> bytes len', inner.length, ' hex:', inner.toString('hex'));
} catch (e) { console.log('  not base64:', e.message); }

const otp = Buffer.from(otpB64, 'base64');
console.log('otp response base64 -> bytes len', otp.length, ' hex:', otp.toString('hex'));

// known captured ClearKey for this content (Algorithms log, childId 699fe7fb...)
console.log('\nknown captured key  k  = d01c5e84e4cd6b4b2de6831f2edc61d7 (16 bytes)');
console.log('known captured kid     = a199e3ccf9d614a6ffe7f749895761c6 (16 bytes)');
console.log('mpd default_KID        = a199e3ccf9d614a6ffe7f749895761c6  (MATCHES kid)');
