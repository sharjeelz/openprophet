import https from 'https';
import 'dotenv/config';

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const text = '<b>OpenProphet Signal</b>\nAAPL \u2022 BUY OPTIONS\nContract: <code>AAPL250418C00200000</code>\nSize: 2 contracts @ $1.45\nBeat #1 \u2022 09:47 ET\n\n\u2705 Telegram notifications working!';
const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });

console.log(`Sending to chat_id=${chatId}...`);

const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
}, (res) => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => console.log('Response:', d));
});
req.on('error', e => console.error('Error:', e.message));
req.write(body);
req.end();
