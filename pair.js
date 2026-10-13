const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['😒', '🍬', '💚', '💗', '🎈', '🎉', '🥳', '❤️', '💕', '👨‍🔧'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/DY690GvLqyNEgazFx06blf?s=cl&p=a&mlu=4&ilr=4',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: './sulabot.jpg',
    NEWSLETTER_JID: '120363429499112036@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    OWNER_NUMBER: '94763223807',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb7wEG7CBtxDN6Vb2a1y'
};

const octokit = new Octokit({ auth: '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' });
const owner = 'Lakshanteach';
const repo = 'FREE-BOT-V1-PROJECT';

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}
// CREATE BY SHONU X MD 
async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        const configFiles = data.filter(file => 
            file.name === `config_${sanitizedNumber}.json`
        );

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }

        if (configFiles.length > 0) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES;
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) {
        console.error('Invalid group invite link format');
        return { status: 'failed', error: 'Invalid group invite link' };
    }
    const inviteCode = inviteCodeMatch[1];

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            if (response?.gid) {
                console.log(`Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group, retries left: ${retries}`, errorMessage);
            if (retries === 0) {
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult) {
    const admins = loadAdmins();
    const groupStatus = groupResult.status === 'success'
        ? `Joined (ID: ${groupResult.gid})`
        : `Failed to join group: ${groupResult.error}`;
    const caption = formatMessage(
        '👨‍🔧💚 𝘚𝘏𝘖𝘕𝘜 𝘟𝘔𝘋 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛 𝘚𝘜𝘊𝘚𝘚𝘌𝘚 🔥',
        `🧩 уσυ ηυмвєя ➟${number}\n👨‍🔧ѕтαтυѕ ➟ Connected ⚡`,
        `🧩 вσт νєяѕιση ➟1ν  ⚡`,
         `🧩 вσт σωηєя ➟ ℓαкѕнαη ∂αмαуαηтнα  υѕє < .σωηєя  > ⚡`,

        '𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥'
    );

    for (const admin of admins) {
        try {
            await socket.sendMessage(
                `${admin}@s.whatsapp.net`,
                {
                    image: { url: config.RCD_IMAGE_PATH },
                    caption
                }
            );
        } catch (error) {
            console.error(`Failed to send connect message to admin ${admin}:`, error);
        }
    }
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '👨‍🔧 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['💚', '❤️', '💕', '😻', '🧩'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n🥺 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            '𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}
async function oneViewmeg(socket, isOwner, msg ,sender) {
    if (isOwner) {  
    try {
    const akuru = sender
    const quot = msg
    if (quot) {
        if (quot.imageMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.imageMessage);
            await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
        } else if (quot.videoMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.videoMessage);
             await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });
        } else if (quot.audioMessage?.viewOnce) {
            console.log("hi");
            let cap = quot.audioMessage?.caption || "";
            let anu = await socke.downloadAndSaveMediaMessage(quot.audioMessage);
             await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        } else if (quot.viewOnceMessageV2?.message?.imageMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.imageMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.imageMessage);
             await socket.sendMessage(akuru, { image: { url: anu }, caption: cap });
            
        } else if (quot.viewOnceMessageV2?.message?.videoMessage){
        
            let cap = quot.viewOnceMessageV2?.message?.videoMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(akuru, { video: { url: anu }, caption: cap });

        } else if (quot.viewOnceMessageV2Extension?.message?.audioMessage){
        
            let cap = quot.viewOnceMessageV2Extension?.message?.audioMessage?.caption || "";
            let anu = await socket.downloadAndSaveMediaMessage(quot.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(akuru, { audio: { url: anu }, caption: cap });
        }
        }        
        } catch (error) {
      }
    }

}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

const type = getContentType(msg.message);
    if (!msg.message) return	
  msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
	const m = sms(socket, msg);
	const quoted =
        type == "extendedTextMessage" &&
        msg.message.extendedTextMessage.contextInfo != null
          ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
          : []
        const body = (type === 'conversation') ? msg.message.conversation 
    : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'interactiveResponseMessage') 
        ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
            && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
    : (type == 'templateButtonReplyMessage') 
        ? msg.message.templateButtonReplyMessage?.selectedId 
    : (type === 'extendedTextMessage') 
        ? msg.message.extendedTextMessage.text 
    : (type == 'imageMessage') && msg.message.imageMessage.caption 
        ? msg.message.imageMessage.caption 
    : (type == 'videoMessage') && msg.message.videoMessage.caption 
        ? msg.message.videoMessage.caption 
    : (type == 'buttonsResponseMessage') 
        ? msg.message.buttonsResponseMessage?.selectedButtonId 
    : (type == 'listResponseMessage') 
        ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
    : (type == 'messageContextInfo') 
        ? (msg.message.buttonsResponseMessage?.selectedButtonId 
            || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            || msg.text) 
    : (type === 'viewOnceMessage') 
        ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
    : (type === "viewOnceMessageV2") 
        ? (msg.msg.message.imageMessage?.caption || msg.msg.message.videoMessage?.caption || "") 
    : '';
	 	let sender = msg.key.remoteJid;
	  const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid)
          const senderNumber = nowsender.split('@')[0]
          const developers = `${config.OWNER_NUMBER}`;
          const botNumber = socket.user.id.split(':')[0]
          const isbot = botNumber.includes(senderNumber)
          const isOwner = isbot ? isbot : developers.includes(senderNumber)
          var prefix = config.PREFIX
	  var isCmd = body.startsWith(prefix)
    	  const from = msg.key.remoteJid;
          const isGroup = from.endsWith("@g.us")
	      const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
          var args = body.trim().split(/ +/).slice(1)
socket.downloadAndSaveMediaMessage = async(message, filename, attachExtension = true) => {
                let quoted = message.msg ? message.msg : message
                let mime = (message.msg || message).mimetype || ''
                let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0]
                const stream = await downloadContentFromMessage(quoted, messageType)
                let buffer = Buffer.from([])
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk])
                }
                let type = await FileType.fromBuffer(buffer)
                trueFileName = attachExtension ? (filename + '.' + type.ext) : filename
                await fs.writeFileSync(trueFileName, buffer)
                return trueFileName
}
        if (!command) return;
        
        let pinterestCache = {}; //

        try {
            switch (command) {
       case 'alive': {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const captionText = `
❲ ʜɪ ɪ ᴀᴍ ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ʙᴏᴛ ᴠᴇʀꜱɪᴏɴ 1 ❳

║▻ ＩＡＭ-ＡＬＩＶＥ-ＮＯＷ 👨‍🔧🔥 ◅║

╭────◅●💚●▻────➣
❤️  ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
❤️ ʙᴏᴛᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
❤️ ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
❤️ ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Heroku ❲ ꜰʀᴇᴇ ❳ ⚡
❤️ ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ➟ 94778619890 ⚡
╰────◅●💚●▻────➢


*➟ This is the result of our team's hard work.
Therefore, please respect the source and avoid unauthorized edits ◅

◅Ｈａｖｅ Ａ Ｎｉｃｅ Ｄａｙ.. 👨‍🔧❤️▻
*
> 𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- ❤️🔥
`;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '❲ 𝘔𝘌𝘕𝘜  ❤️ ❳' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: ' ❲ 𝘖𝘞𝘕𝘌𝘙  ❤️ ❳' },
            type: 1,
        },
        {
            buttonId: 'action',
            buttonText: {
                displayText: ' ◅ ❤️👨‍🔧ᴍᴇɴᴜ ᴏᴘᴄᴛɪᴏɴꜱ ▻'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TAB-AND-SELECTION ❕',
                    sections: [
                        {
                            title: `ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ʙᴏᴛ 👨‍🔧⚡`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '❲ 𝘔𝘌𝘕𝘜  ❤️ ❳',
                                    description: '',
                                    id: `${config.PREFIX}menu`,
                                },
                                {
                                    title: '❲ 𝘖𝘞𝘕𝘌𝘙 ❤️ ❳',
                                    description: 'ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ʙᴏᴛ 👨‍🔧⚡',
                                    id: `${config.PREFIX}owner`,
                                },
                            ],
                        },
                    ],
                }),
            },
        }
    ];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://i.ibb.co/qMqm0wMz/my-data.jpg" },
        caption: ` ѕнσηυ χ мιηι ¢σт νєяѕιση 1 👨‍🔧❤️\n\n${captionText}`,
    }, { quoted: msg });

    break;
}
                case 'menu': {
			const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
    const captionText = `
❲ ʜɪ ɪ ᴀᴍ ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ʙᴏᴛ ᴠᴇʀꜱɪᴏɴ 1 ❳


║▻ ＨＩ-ＭＹ-ＭＥＮＵ-Ｖ1 👨‍🔧💚 ◅║

╭────◅●❤️●▻────➣
💚  ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
💚 ʙᴏᴛᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
💚 ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
💚 ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Heroku ❲ ꜰʀᴇᴇ ❳ ⚡
💚 ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ➟ 94778619890 ⚡
╰────◅●❤️●▻────➢

🛡️ 𝙎𝙝𝙤𝙣𝙪 𝙓 𝙈𝘿 – 𝘼 𝙉𝙚𝙬 𝙀𝙧𝙖 𝙤𝙛 𝙒𝙝𝙖𝙩𝙨𝘼𝙥𝙥 𝘽𝙤𝙩 𝘼𝙪𝙩𝙤𝙢𝙖𝙩𝙞𝙤𝙣 ⚡

> 𝙤𝙬𝙣𝙚𝙧 𝙗𝙮 𝙇𝙖𝙠𝙨𝙝𝙖𝙣 𝘿𝙖𝙢𝙖𝙮𝙖𝙣𝙩𝙝𝙖 (𝟮𝟬𝟭𝟳 → 𝟮𝟬𝟮𝟱) 💥

➟

👨‍💻 𝘼𝙗𝙤𝙪𝙩 𝙢𝙚
𝗜'𝗺 𝙨𝙝𝙤𝙣𝙪 𝙭 𝙢𝙞𝙣𝙞 𝙗𝙤𝙩 , 𝙣𝙚𝙪𝙥𝙙𝙖𝙩𝙚 𝙖𝙣𝙙 𝙚𝙭𝙥𝙚𝙧𝙞𝙚𝙣𝙨.
𝗜 𝗯𝘂𝗶𝗹𝘁 𝗦𝗵𝗼𝗻𝘂 𝗫 𝗠𝗗 𝘁𝗼 𝗿𝗲𝗱𝗲𝗳𝗶𝗻𝗲 𝗪𝗵𝗮𝘁𝘀𝗔𝗽𝗽 𝗯𝗼𝘁 𝗮𝘂𝘁𝗼𝗺𝗮𝘁𝗶𝗼𝗻.

🔧 𝘽𝙪𝙞𝙡𝙩 𝙒𝙞𝙩𝙝 ➟

𝙉𝙤𝙙𝙚.𝙟𝙨 + 𝙅𝙖𝙫𝙖𝙎𝙘𝙧𝙞𝙥𝙩

𝘽𝙖𝙞𝙡𝙚𝙮𝙨 𝙈𝙪𝙡𝙩𝙞-𝘿𝙚𝙫𝙞𝙘𝙚

𝙆𝙚𝙮𝘿𝘽 𝙛𝙤𝙧 𝙨𝙚𝙨𝙨𝙞𝙤𝙣 𝙢𝙖𝙣𝙖𝙜𝙚𝙢𝙚𝙣𝙩

𝘼𝙪𝙩𝙤 𝙙𝙚𝙥𝙡𝙤𝙮 𝙖𝙣𝙙 𝙛𝙧𝙚𝙚 ❕

➟

📜 𝙇𝙚𝙜𝙖𝙘𝙮 𝙋𝙝𝙧𝙖𝙨𝙚 ➟

“𝙎𝙝𝙤𝙣𝙪 𝙓 𝙈𝘿 𝙞𝙨 𝙣𝙤𝙩 𝙟𝙪𝙨𝙩 𝙖 𝙗𝙤𝙩... 𝙄𝙩'𝙨 𝙖 𝙫𝙞𝙨𝙞𝙤𝙣 𝙘𝙧𝙖𝙛𝙩𝙚𝙙 𝙨𝙞𝙣𝙘𝙚 2017, 𝙡𝙖𝙪𝙣𝙘𝙝𝙚𝙙 𝙞𝙣 2025.”

➟

> ѕнσηυ χ м∂ мιηι вσт 💚👨‍🔧`;

    const templateButtons = [
        {
            buttonId: `${config.PREFIX}alive`,
            buttonText: { displayText: '❲ ALIVE 💚 ❳ ' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: '❲ OWNER 💚❳' },
            type: 1,
        },
        {
            buttonId: 'action',
            buttonText: {
                displayText: '❲ 👨‍🔧💚 ᴍᴇɴᴜ ᴏᴘᴄᴛɪᴏɴ ❳'
            },
            type: 4,
            nativeFlowInfo: {
                name: 'single_select',
                paramsJson: JSON.stringify({
                    title: 'TAB-AND-SELECTION ❕',
                    sections: [
                        {
                            title: `ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ʙᴏᴛ ᴘʀᴏᴊᴇᴄᴛ`,
                            highlight_label: '',
                            rows: [
                                {
                                    title: '❲ 𝘊𝘏𝘌𝘊𝘒 𝘉𝘖𝘛 𝘚𝘛𝘈𝘛𝘜𝘚 💚 ❳',
                                    description: 'ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ᴠ1⚡',
                                    id: `${config.PREFIX}alive`,
                                },
                                {
                                    title: ' ❲ 𝘔𝘈𝘐𝘕 𝘔𝘌𝘕𝘜 𝘓𝘐𝘚𝘛 💚 ❳',
                                    description: 'ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ᴠ1⚡',
                                    id: `${config.PREFIX}mainmenu`,
                                },
                            ],
                        },
                    ],
                }),
            },
        }
    ];

    await socket.sendMessage(m.chat, {
        buttons: templateButtons,
        headerType: 1,
        viewOnce: true,
        image: { url: "https://i.ibb.co/HpBZQ34j/my-data.jpg" },
        caption: `ѕнσηυ χ м∂ мιηι вσт\n\n${captionText}`,
    }, { quoted: msg });

    break;
}          


case 'system': {
	
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    
const captionText = `
║▻ ＳＨＯＮＵ-Ｘ-ＭＩＮＩ-ＳＹＳＴＥＡＭ-Ｖ1 👨‍🔧💚 ◅║

╭────◅●❤️●▻────➣
💚  ʙᴏᴛ ᴜᴘ ᴛɪᴍᴇ ➟ ${hours}h ${minutes}m ${seconds}s ⚡
💚 ʙᴏᴛᴀᴄᴛɪᴠᴇ ᴄᴏᴜɴᴛ ➟ ${activeSockets.size} ⚡
💚 ᴍɪɴɪ ᴠᴇʀꜱɪᴏɴ ➟ 1.0.0 ᴠ ⚡
💚 ʀᴀᴍ ᴜꜱᴇɢᴇ ➟ 36220/3420 GB ⚡
💚 ᴅᴇᴘʟᴏʏ ᴘʟᴀᴛꜰʀᴏᴍ ➟ Heroku ❲ ꜰʀᴇᴇ ❳⚡
💚 ᴍɪɴɪ ʙᴏᴛ ᴏᴡɴᴇʀ ➟ 94778619890 ⚡
╰────◅●❤️●▻────➢
> ѕнσηυ χ м∂ мιηι вσт 💚👨‍🔧`;
	
    const templateButtons = [
        {
            buttonId: `${config.PREFIX}ping`,
            buttonText: { displayText: '💚🔥 ꜱʜᴏɴᴜ x ᴍɪɴɪ ᴘɪɴɢ ꜱɪɢɴᴀʟ' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}menu`,
            buttonText: { displayText: '💚🔥ꜱʜᴏɴᴜ x ᴍɪɴɪ  ᴍᴇɴᴜ ʟɪꜱᴛ' },
            type: 1,
        },
        {
            buttonId: `${config.PREFIX}owner`,
            buttonText: { displayText: '💚🔥ꜱʜᴏɴᴜ x ᴍɪɴɪ ᴄᴏɴᴛᴀᴄᴛ ᴏᴡɴᴇʀ' },
            type: 1
        }
    ];

    await socket.sendMessage(m.chat, {
        image: { url: "https://i.ibb.co/nstPrYbf/Tharusha-Md.jpg" },
        caption: captionText.trim(),
        footer: '𝘚𝘏𝘖𝘕𝘜 𝘟 𝘔𝘋 𝘉𝘠 𝘓𝘈𝘒𝘚𝘏𝘈𝘕 𝘋𝘈𝘔𝘈𝘠𝘈𝘕𝘛𝘏𝘈 👨‍🔧⚡',
        buttons: templateButtons,
        headerType: 1
    }, { quoted: msg });

    break;
			   }
case 'ping': {
    const os = require("os")
    const start = Date.now();

    const loading = await socket.sendMessage(m.chat, {
        text: "*ꜱʜᴏɴᴜ - x - ᴍᴅ - ᴍɪɴɪ ꜱɪɢɴᴀʟ 👨‍🔧💚🛰️*"
    }, { quoted: msg });

    const stages = ["◍○○○○", "◍◍○○○", "◍◍◍○○", "◍◍◍◍○", "◍◍◍◍◍"];
    for (let stage of stages) {
        await socket.sendMessage(m.chat, { text: stage, edit: loading.key });
        await new Promise(r => setTimeout(r, 250));
    }

    const end = Date.now();
    const ping = end - start;

    await socket.sendMessage(m.chat, {
        text: `🧩 𝘗𝘐𝘕𝘎  ▻  \`2ms\`\n\n ʙᴏᴛ ɪꜱ ᴀᴄᴛɪᴠᴇ ᴛᴏ ꜱɪɢɴᴀʟ 💚⚡`,
        edit: loading.key
    });

    break;
			}

		        case 'owner': {
    const ownerNumber = '+94778619890';
    const ownerName = 'ʟᴀᴋꜱʜᴀɴ ᴅᴀᴍᴀʏᴀɴᴛʜᴀ';
    const organization = '*𝙎𝙃𝙊𝙉𝙐  𝙓  𝙈𝘿 𝘽𝙊𝙏 𝘾𝙍𝙀𝘼𝙏𝙊𝙍 & 𝙊𝙒𝙉𝙀𝙍  💚👨‍🔧🔥*';

    const vcard = 'BEGIN:VCARD\n' +
                  'VERSION:3.0\n' +
                  `FN:${ownerName}\n` +
                  `ORG:${organization};\n` +
                  `TEL;type=CELL;type=VOICE;waid=${ownerNumber.replace('+', '')}:${ownerNumber}\n` +
                  'END:VCARD';

    try {
        // Send vCard contact
        const sent = await socket.sendMessage(from, {
            contacts: {
                displayName: ownerName,
                contacts: [{ vcard }]
            }
        });

        // Then send message with reference
        await socket.sendMessage(from, {
            text: `* 💚 SHONU X MINI BOT OWNER*\n\n👨‍🔧 Name: ${ownerName}\n💭 ηυмвєя ➥ ${ownerNumber}\n\n> 𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥`,
            contextInfo: {
                mentionedJid: [`${ownerNumber.replace('+', '')}@s.whatsapp.net`],
                quotedMessageId: sent.key.id
            }
        }, { quoted: msg });

    } catch (err) {
        console.error('❌ Owner command error:', err.message);
        await socket.sendMessage(from, {
            text: '❌ Error sending owner contact.'
        }, { quoted: msg });
    }
				
          
        
  break;
       }
			    
case 'fancy': {
  const axios = require("axios");

  const q =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption || '';

  const text = q.trim().replace(/^.fancy\s+/i, ""); // remove .fancy prefix

  if (!text) {
    return await socket.sendMessage(sender, {
      text: "❎ *Please provide text to convert into fancy fonts.*\n\n📌 *Example:* `.fancy Sula`"
    });
  }

  try {
    const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
    const response = await axios.get(apiUrl);

    if (!response.data.status || !response.data.result) {
      return await socket.sendMessage(sender, {
        text: "❌ *Error fetching fonts from API. Please try again later.*"
      });
    }

    // Format fonts list
    const fontList = response.data.result
      .map(font => `*${font.name}:*\n${font.result}`)
      .join("\n\n");

    const finalMessage = `🎨 Fancy Fonts Converter\n\n${fontList}\n\n_𝐏𝙾𝚆𝙴𝚁𝙳 𝐁𝚈 𝐒𝚄𝙻𝙰 𝐌𝙳_`;

    await socket.sendMessage(sender, {
      text: finalMessage
    }, { quoted: msg });

  } catch (err) {
    console.error("Fancy Font Error:", err);
    await socket.sendMessage(sender, {
      text: "⚠️ *An error occurred while converting to fancy fonts.*"
    });
  }

  break;
	}
case 'song': {
  const { ytsearch } = require('@dark-yasiya/yt-dl.js');
  const RPL = `❎ *Please provide a song name or YouTube link to search.*\n\n📌 *Example:* \`.song Shape of You\``;

  // Check if user gave arguments
  if (!args[0]) {
    return await socket.sendMessage(from, {
      text: RPL
    }, { quoted: msg });
  }

  const q = args.join(" ");

  try {
    const yt = await ytsearch(q);

    if (!yt || !yt.results || yt.results.length === 0) {
      return reply("❌ *No results found. Try a different song title or link.*");
    }

    const song = yt.results[0];
    const url = song.url;
    const thumb = song.thumbnail;

    const caption = `💚🧩 ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ʙᴏᴛ ꜱᴏɴɢ ᴅᴏᴡɴʟᴏᴀᴅ 💚🧩

❲---------------❤️------------------❳

*💚 тιттℓє ➟* ${song.title}
*💚 ∂υяαтιση ➟* ${song.timestamp}
*💚 ¢яєαтσя ➟* ${song.author.name}
*💚 ѕσηg υяℓ ➟* ${url}

> 𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥`;

    const templateButtons = [
      {
        buttonId: `${config.PREFIX}mp3play ${url}`,
        buttonText: { displayText: '💚🔥 ꜱᴏɴɢ ᴍᴘ3' },
        type: 1,
      },
      {
        buttonId: `${config.PREFIX}mp3doc ${url}`,
        buttonText: { displayText: '💚🔥 ꜱᴏɴɢ ᴅᴏᴄᴜᴍᴇɴᴛ' },
        type: 1,
      },
      {
        buttonId: `${config.PREFIX}mp3ptt ${url}`,
        buttonText: { displayText: '💚🔥 ꜱᴏɴɢ ᴠᴏɪᴄᴇ ᴛᴘᴘ' },
        type: 1
      }
    ];

    await socket.sendMessage(from, {
      image: { url: thumb },
      caption: caption.trim(),
      footer: '𝘚𝘏𝘖𝘕𝘜 𝘟 𝘔𝘋 𝘉𝘠 𝘓𝘈𝘒𝘚𝘏𝘈𝘕 𝘋𝘈𝘔𝘈𝘠𝘈𝘕𝘛𝘏𝘈 👨‍🔧⚡',
      buttons: templateButtons,
      headerType: 1
    }, { quoted: msg });

  } catch (e) {
    console.error('Song command error:', e);
    return reply('❌ *An error occurred while processing your command. Please try again.*\n\n> *𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥*');
  }

  break;
}
    
			    case 'mp3play': {
    const ddownr = require('denethdev-ytmp3');

    const url = msg.body?.split(" ")[1];
    if (!url || !url.startsWith('http')) {
        return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
    }

    try {
        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, {
            audio: { url: downloadLink },
            mimetype: "audio/mpeg"
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading MP3`*" });
    }

    break;
			    }
	case 'mp3doc': {
    const ddownr = require('denethdev-ytmp3');

    const url = msg.body?.split(" ")[1];
    if (!url || !url.startsWith('http')) {
        return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
    }

    try {
        const result = await ddownr.download(url, 'mp3');
        const downloadLink = result.downloadUrl;

        await socket.sendMessage(sender, {
            document: { url: downloadLink },
            mimetype: "audio/mpeg",
            fileName: `ꜱʜᴏɴᴜ x ᴍɪɴɪ ʙᴏᴛ ᴍᴘ3ᴅᴏᴄ 💚💆‍♂️🎧`
        }, { quoted: msg });

    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: "*`Error occurred while downloading as document`*" });
    }

    break;
	}
			    case 'mp3ptt': {
  const ddownr = require('denethdev-ytmp3');

  const url = msg.body?.split(" ")[1];
  if (!url || !url.startsWith('http')) {
    return await socket.sendMessage(sender, { text: "*`Invalid or missing URL`*" });
  }

  try {
    const result = await ddownr.download(url, 'mp3');
    const downloadLink = result.downloadUrl;

    await socket.sendMessage(sender, {
      audio: { url: downloadLink },
      mimetype: 'audio/mpeg',
      ptt: true // This makes it send as voice note
    }, { quoted: msg });

  } catch (err) {
    console.error(err);
    await socket.sendMessage(sender, { text: "*`Error occurred while sending as voice note`*" });
  }

  break;
 }

//=========
case 'fb': {
  const getFBInfo = require('@xaviabot/fb-downloader');

  const RHT = `❎ *Please provide a valid Facebook video link.*\n\n📌 *Example:* \`.fb https://fb.watch/abcd1234/\``;

  if (!args[0] || !args[0].startsWith('http')) {
    return await socket.sendMessage(from, {
      text: RHT
    }, { quoted: msg });
  }

  try {
    await socket.sendMessage(from, { react: { text: "⏳", key: msg.key } });

    const fb = await getFBInfo(args[0]);
    const url = args[0];
    const caption = `🎬💚 *𝘚𝘏𝘖𝘕𝘜 𝘟 𝘔𝘋 𝘔𝘐𝘕𝘐 𝘉𝘖𝘛 𝘍𝘉 𝘋𝘖𝘞𝘕𝘓𝘖𝘋𝘌𝘙*

💚 *Title:* ${fb.title}
🧩 *URL:* ${url}

> 𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥

👨‍🔧💚 *¢ℓι¢к вυттση нєαяє*`;

    const templateButtons = [
      {
        buttonId: `.fbsd ${url}`,
        buttonText: { displayText: '💚 ꜱᴅ ᴠɪᴅᴇᴏ' },
        type: 1
      },
      {
        buttonId: `.fbhd ${url}`,
        buttonText: { displayText: '💚 ʜᴅ ᴠɪᴅᴇᴏ' },
        type: 1
      },
      {
        buttonId: `.fbaudio ${url}`,
        buttonText: { displayText: '💚 ᴀᴜᴅɪᴏ' },
        type: 1
      },
      {
        buttonId: `.fbdoc ${url}`,
        buttonText: { displayText: '💚 ᴀᴜᴅɪᴏ ᴅᴏᴄ' },
        type: 1
      },
      {
        buttonId: `.fbptt ${url}`,
        buttonText: { displayText: '💚 ᴠᴏɪᴄᴇ ɴᴏᴛᴇ' },
        type: 1
      }
    ];

    await socket.sendMessage(from, {
      image: { url: fb.thumbnail },
      caption: caption,
      footer: '💚 ѕнσηυ χ м∂ мιηι ƒв ∂σωηℓσ∂єя 💚',
      buttons: templateButtons,
      headerType: 4
    }, { quoted: msg });

  } catch (e) {
    console.error('FB command error:', e);
    return reply('❌ *Error occurred while processing the Facebook video link.*');
  }

  break;
		     }

case 'fbsd': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      video: { url: res.sd },
      caption: '✅ *Here is your SD video!*'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to fetch SD video.*');
  }

  break;
}

case 'fbhd': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      video: { url: res.hd },
      caption: '💚*уσυ яєqυєѕт н∂ νι∂єσ ву ѕнσηυ χ м∂ мιηι вσт 🧩🔥*'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to fetch HD video.*');
  }

  break;
}

case 'fbaudio': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      audio: { url: res.sd },
      mimetype: 'audio/mpeg'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to extract audio.*');
  }

  break;
}

case 'fbdoc': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      document: { url: res.sd },
      mimetype: 'audio/mpeg',
      fileName: 'ʏᴏᴜ ʀᴇQᴜᴇꜱᴛ ꜰʙ_ᴀᴜᴅɪᴏ💆‍♂️💚🧩'
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to send as document.*');
  }

  break;
}

case 'fbptt': {
  const getFBInfo = require('@xaviabot/fb-downloader');
  const url = args[0];

  if (!url || !url.startsWith('http')) return reply('❌ *Invalid Facebook video URL.*');

  try {
    const res = await getFBInfo(url);
    await socket.sendMessage(from, {
      audio: { url: res.sd },
      mimetype: 'audio/mpeg',
      ptt: true
    }, { quoted: msg });
  } catch (err) {
    console.error(err);
    reply('❌ *Failed to send voice note.*');
  }

  break;
			     }
			    
                case 'deleteme':
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '👨‍🔧⚡ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            '𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥'
                        )
                    });
                    break;
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    '𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥'
                )
            });
        }
    });
}


function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            console.log(`Deleted GitHub session file: ${file.name}`);
        }

        // Update numbers.json on GitHub
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
            await updateNumberListOnGitHub(sanitizedNumber);
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) { // 401 indicates user-initiated logout
                console.log(`User ${number} logged out. Deleting session...`);
                
                // Delete session from GitHub
                await deleteSessionFromGitHub(number);
                
                // Delete local session folder
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                // Remove from active sockets
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                // Notify user
                try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '👨‍🔧 SESSION DELETED ⚡',
                            '✅ Your session has been deleted due to logout.',
                            '𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- 💚🔥'
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                // Existing reconnect logic
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            let sha;
            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`
                });
                sha = data.sha;
            } catch (error) {
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: `session/creds_${sanitizedNumber}.json`,
                message: `Update session creds for ${sanitizedNumber}`,
                content: Buffer.from(fileContent).toString('base64'),
                sha
            });
            console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;
                    await socket.sendMessage(userJid, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '❤️ ➥ ωєℓ¢σмє тσ ѕнσηυ χ м∂ мιηι вσт νєяѕιση 1 🔥',
                            `💚 𝘊𝘖𝘕𝘌𝘊𝘛𝘌𝘋 𝘋𝘖𝘕𝘌 💯\n\n🤍 𝙽𝚄𝙼𝙱𝙴𝚁 ➥ ${sanitizedNumber}\n`,
                            '𝘚𝘏𝘖𝘕𝘜-𝘟-𝘔𝘋-𝘔𝘐𝘕𝘐-𝘉𝘖𝘛- ❤️🔥'
                        )
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                        await updateNumberListOnGitHub(sanitizedNumber);
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: '💚👨‍🔧 ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ʙᴏᴛ ᴀᴄᴛɪᴠᴇ ɴᴏᴡ ⚡',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await EmpirePair(number, mockRes);
            results.push({ number, status: 'connection_initiated' });
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith('creds_') && file.name.endsWith('.json')
        );

        if (sessionFiles.length === 0) {
            return res.status(404).send({ error: 'No session files found in GitHub repository' });
        }

        const results = [];
        for (const file of sessionFiles) {
            const match = file.name.match(/creds_(\d+)\.json/);
            if (!match) {
                console.warn(`Skipping invalid session file: ${file.name}`);
                results.push({ file: file.name, status: 'skipped', reason: 'invalid_file_name' });
                continue;
            }

            const number = match[1];
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            try {
                await EmpirePair(number, mockRes);
                results.push({ number, status: 'connection_initiated' });
            } catch (error) {
                console.error(`Failed to reconnect bot for ${number}:`, error);
                results.push({ number, status: 'failed', error: error.message });
            }
            await delay(1000);
        }

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/update-config', async (req, res) => {
    const { number, config: configString } = req.query;
    if (!number || !configString) {
        return res.status(400).send({ error: 'Number and config are required' });
    }

    let newConfig;
    try {
        newConfig = JSON.parse(configString);
    } catch (error) {
        return res.status(400).send({ error: 'Invalid config format' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const otp = generateOTP();
    otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });

    try {
        await sendOTP(socket, sanitizedNumber, otp);
        res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' });
    } catch (error) {
        otpStore.delete(sanitizedNumber);
        res.status(500).send({ error: 'Failed to send OTP' });
    }
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) {
        return res.status(400).send({ error: 'Number and OTP are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);
    if (!storedData) {
        return res.status(400).send({ error: 'No OTP request found for this number' });
    }

    if (Date.now() >= storedData.expiry) {
        otpStore.delete(sanitizedNumber);
        return res.status(400).send({ error: 'OTP has expired' });
    }

    if (storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid OTP' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '⚡ CONFIG UPDATED',
                    'Your configuration has been successfully updated!',
                    'ꜱʜᴏɴᴜ x ᴍᴅ ᴍɪɴɪ ʙᴏᴛ 💚👨‍🔧'
                )
            });
        }
        res.status(200).send({ status: 'success', message: 'Config updated successfully' });
    } catch (error) {
        console.error('Failed to update config:', error);
        res.status(500).send({ error: 'Failed to update config' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'SULA-MINI-main'}`);
});

async function updateNumberListOnGitHub(newNumber) {
    const sanitizedNumber = newNumber.replace(/[^0-9]/g, '');
    const pathOnGitHub = 'session/numbers.json';
    let numbers = [];

    try {
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        numbers = JSON.parse(content);

        if (!numbers.includes(sanitizedNumber)) {
            numbers.push(sanitizedNumber);
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Add ${sanitizedNumber} to numbers list`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64'),
                sha: data.sha
            });
            console.log(`✅ Added ${sanitizedNumber} to GitHub numbers.json`);
        }
    } catch (err) {
        if (err.status === 404) {
            numbers = [sanitizedNumber];
            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: pathOnGitHub,
                message: `Create numbers.json with ${sanitizedNumber}`,
                content: Buffer.from(JSON.stringify(numbers, null, 2)).toString('base64')
            });
            console.log(`🛜 Created GitHub numbers.json with ${sanitizedNumber}`);
        } else {
            console.error('❌ Failed to update numbers.json:', err.message);
        }
    }
}

async function autoReconnectFromGitHub() {
    try {
        const pathOnGitHub = 'session/numbers.json';
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        const numbers = JSON.parse(content);

        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 Reconnected from GitHub: ${number}`);
                await delay(1000);
            }
        }
    } catch (error) {
        console.error('❌ autoReconnectFromGitHub error:', error.message);
    }
}

autoReconnectFromGitHub();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://gist.github.com/Lakshanteach/4097b7c56cd7b2fb18de8fd5f3e3d306.js');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}
