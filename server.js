// Serveur : connecte ton compte WhatsApp (Baileys), suit ta chaîne et réagit aux messages.
// Lancer :  BOT_NUMBER=509XXXXXXXX node server.js   (numéro sans + ni espaces)
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const BOT_NUMBER = (process.env.BOT_NUMBER || '').replace(/\D/g, '');
const DB = path.join(__dirname, 'channels.json');

let channels = fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : {};
const saveDb = () => fs.writeFileSync(DB, JSON.stringify(channels, null, 2));

let sock = null;
let connected = false;

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'session'));
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
  });

  // Première connexion : code de jumelage (WhatsApp > Appareils connectés > Lier avec un numéro)
  let pairingAsked = false;
  if (!sock.authState.creds.registered) {
    if (!/^\d{10,15}$/.test(BOT_NUMBER)) {
      console.log('❌ BOT_NUMBER invalide. Format : indicatif pays + numéro, chiffres seulement.');
      console.log('   Exemple Haïti : BOT_NUMBER=50931234567 (sans +, sans espaces, sans 0 au début)');
      process.exit(1);
    }
    // On demande le code seulement quand WhatsApp est prêt (événement "qr")
    sock.ev.on('connection.update', async ({ qr }) => {
      if (!qr || pairingAsked) return;
      pairingAsked = true;
      try {
        const code = await sock.requestPairingCode(BOT_NUMBER);
        const nice = code.match(/.{1,4}/g).join('-');
        console.log('🔑 CODE DE JUMELAGE :', nice, ' (pour le numéro ' + BOT_NUMBER + ')');
      } catch (e) { console.log('Erreur code de jumelage :', e.message); }
    });
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      connected = true;
      console.log('✅ WhatsApp connecté');
      // Se réabonner aux chaînes déjà enregistrées
      Object.values(channels).forEach(c => sock.subscribeNewsletterUpdates?.(c.jid).catch(() => {}));
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) start();
      else console.log('Session déconnectée : supprime le dossier "session" et relance.');
    }
  });

  // Nouveau message dans une chaîne suivie -> réaction automatique
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      const jid = m.key?.remoteJid;
      if (!jid || !jid.endsWith('@newsletter')) continue;
      const ch = Object.values(channels).find(c => c.jid === jid);
      if (!ch) continue;
      const serverId = m.key.server_id || m.newsletter_server_id;
      if (!serverId) continue;
      await react(jid, serverId, pick(ch.emojis));
    }
  });
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

async function react(jid, serverId, emoji) {
  try {
    await sock.newsletterReactMessage(jid, String(serverId), emoji);
    console.log(`${emoji} réaction envoyée (${jid})`);
    return true;
  } catch (e) {
    console.log('Réaction échouée :', e.message);
    return false;
  }
}

const getCode = link => (link.match(/whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/) || [])[1];

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/status', (req, res) => res.json({ ok: true, connected }));

app.post('/connect', async (req, res) => {
  try {
    if (!connected) return res.json({ ok: false, error: 'Serveur pas encore connecté à WhatsApp' });
    const { link, emojis } = req.body;
    const code = getCode(link || '');
    if (!code) return res.json({ ok: false, error: 'Lien de chaîne invalide' });

    const meta = await sock.newsletterMetadata('invite', code);
    const jid = meta.id;
    try { await sock.newsletterFollow(jid); } catch (e) {}
    try { await sock.subscribeNewsletterUpdates?.(jid); } catch (e) {}

    const name = meta.thread_metadata?.name?.text || meta.name || 'Chaîne';
    channels[code] = { jid, name, emojis: emojis?.length ? emojis : ['👍', '❤️', '🔥'] };
    saveDb();
    res.json({ ok: true, name });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Met à jour les emojis choisis
app.post('/emojis', (req, res) => {
  const code = getCode(req.body.link || '');
  if (!channels[code]) return res.json({ ok: false, error: 'Chaîne non connectée' });
  if (req.body.emojis?.length) { channels[code].emojis = req.body.emojis; saveDb(); }
  res.json({ ok: true });
});

// Publie un message dans la chaîne (ton compte doit en être propriétaire/admin) puis réagit
app.post('/send', async (req, res) => {
  try {
    const { link, text } = req.body;
    const code = getCode(link || '');
    const ch = channels[code];
    if (!ch) return res.json({ ok: false, error: 'Chaîne non connectée' });
    const sent = await sock.sendMessage(ch.jid, { text });
    const serverId = sent?.key?.server_id || sent?.newsletter_server_id;
    const emoji = pick(ch.emojis);
    let reacted = [];
    if (serverId) {
      await new Promise(r => setTimeout(r, 1500));
      if (await react(ch.jid, serverId, emoji)) reacted = [emoji];
    }
    res.json({ ok: true, reacted });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`🌐 Site : http://localhost:${PORT}`));
start();
