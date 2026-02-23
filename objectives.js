const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');
require('dotenv').config(); 

const db = new Database('objectives.db');

// --- 1. CONFIGURATION
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GUILD_ID = process.env.GUILD_ID; 

// --- 2. LISTS ---
const ALL_OBJECTIVES = [
    "Common(Green) Vortex", "Uncommon(Blue) Vortex", "Rare(Purple) Vortex", "Legendary(Gold) Vortex",
    "Common(Green) Power Core", "Uncommon(Blue) Power Core", "Rare(Purple) Power Core", "Legendary(Gold) Power Core",
    "4.4 Ore", "5.4 Ore", "6.4 Ore", "7.4 Ore", "8.4 Ore",
    "4.4 Fiber", "5.4 Fiber", "6.4 Fiber", "7.4 Fiber", "8.4 Fiber",
    "4.4 Hide", "5.4 Hide", "6.4 Hide", "7.4 Hide", "8.4 Hide",
    "4.4 Wood", "5.4 Wood", "6.4 Wood", "7.4 Wood", "8.4 Wood"
];

const ALL_ZONES = [
    "Avalanche Incline", "Avalanche Ravine", "Battlebrae Flatland", "Battlebrae Grassland", 
    "Battlebrae Lake", "Battlebrae Meadow", "Battlebrae Peaks", "Battlebrae Plain", 
    "Black Monastery", "Bleachskull Desert", "Bleachskull Steppe", "Braemore Lowland", 
    "Braemore Upland", "Brambleshore Hinterlands", "Citadel of Ash", "Daemonium Keep"
];

// 3. DATABASE SETUP
db.prepare(`CREATE TABLE IF NOT EXISTS objectives (id INTEGER PRIMARY KEY AUTOINCREMENT, objective TEXT, zone TEXT, end_time INTEGER, remaining_seconds INTEGER, status TEXT DEFAULT 'active')`).run();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let isServerOnline = true; 
let lastMessageId = null;

// --- 4. CORE FUNCTIONS ---

async function updateDisplay() {
    const channel = client.channels.cache.get(CHANNEL_ID);
    if (!channel) return;

    const rows = db.prepare("SELECT * FROM objectives ORDER BY end_time ASC").all();
    const embed = new EmbedBuilder()
        .setTitle('🟢 Active Objectives')
        .setColor('#e1e100')
        .setTimestamp();

    if (!isServerOnline) embed.setDescription('⚠️ **Server Maintenance.** Timers Stopped.');
    else if (rows.length === 0) embed.setDescription('✅ No active objectives at the moment.');

    rows.forEach((row) => {
        let label;
        if (row.status === 'paused') {
            const h_rem = Math.floor(row.remaining_seconds / 3600);
            const m_rem = Math.floor((row.remaining_seconds % 3600) / 60);
            label = `⏸️ **Stopped** (${h_rem > 0 ? h_rem + 'h ' : ''}${m_rem}m remaining)`;
        } else {
            const utcTime = new Date(row.end_time * 1000).toISOString().substring(11, 16);
            label = `⌛ <t:${row.end_time}:t> • <t:${row.end_time}:R> • \`${utcTime} UTC\``;
        }
        embed.addFields({ name: `📍 ${row.zone}`, value: `💰 ${row.objective}\n${label}` });
    });

    try {
        if (lastMessageId) {
            const m = await channel.messages.fetch(lastMessageId).catch(() => null);
            if (m) await m.delete().catch(() => null);
        }
        const sent = await channel.send({ embeds: [embed] });
        lastMessageId = sent.id;
    } catch (e) { console.error("Update Error:", e.message); }
}

async function checkServerStatus() {
    const url = "https://serverstatus-ams.albiononline.com/";
    const now = Math.floor(Date.now() / 1000);
    let needsUpdate = false;

    try {
        const deleted = db.prepare("DELETE FROM objectives WHERE end_time <= ? AND status = 'active'").run(now);
        if (deleted.changes > 0) needsUpdate = true;

        const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const data = await response.json();
        const currentOnline = data.status === "online";

        if (!currentOnline) {
            if (isServerOnline) {
                isServerOnline = false;
                db.prepare("SELECT * FROM objectives WHERE status = 'active'").all().forEach(row => {
                    const rem = row.end_time - now;
                    db.prepare("UPDATE objectives SET status = 'paused', remaining_seconds = ? WHERE id = ?").run(rem, row.id);
                });
                needsUpdate = true;
            }
        } else {
            if (!isServerOnline) {
                isServerOnline = true;
                needsUpdate = true;
            }
            const pausedRows = db.prepare("SELECT * FROM objectives WHERE status = 'paused'").all();
            if (pausedRows.length > 0) {
                pausedRows.forEach(row => {
                    const newEnd = now + row.remaining_seconds;
                    db.prepare("UPDATE objectives SET status = 'active', end_time = ?, remaining_seconds = NULL WHERE id = ?").run(newEnd, row.id);
                });
                needsUpdate = true;
            }
        }
        if (needsUpdate) await updateDisplay();
    } catch (e) { console.error("Status Check Error:", e.message); }
}

// --- 5. INTERACTIONS ---

client.on('interactionCreate', async i => {
    if (i.isAutocomplete()) {
        const focusedOption = i.options.getFocused(true);
        let choices = focusedOption.name === 'obj' ? ALL_OBJECTIVES : ALL_ZONES;
        const filtered = choices.filter(c => c.toLowerCase().includes(focusedOption.value.toLowerCase())).slice(0, 25);
        await i.respond(filtered.map(c => ({ name: c, value: c })));
        return;
    }

    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'addobjectives') {
        const h = i.options.getInteger('hours');
        const m = i.options.getInteger('minutes');
        const obj = i.options.getString('obj');
        const zone = i.options.getString('zone');
        const dur = (h * 3600) + (m * 60);
        const endTime = Math.floor(Date.now() / 1000) + dur;

        if (!ALL_ZONES.includes(zone) || !ALL_OBJECTIVES.includes(obj)) {
            return await i.reply({ content: "❌ Please select valid options from the lists!", ephemeral: true });
        }

        if (isServerOnline) {
            db.prepare("INSERT INTO objectives (objective, zone, end_time) VALUES (?, ?, ?)").run(obj, zone, endTime);
        } else {
            db.prepare("INSERT INTO objectives (objective, zone, remaining_seconds, status) VALUES (?, ?, ?, 'paused')").run(obj, zone, dur);
        }

        const utcTime = new Date(endTime * 1000).toISOString().substring(11, 16);
        await i.reply({ content: `✅ **${i.user.username}** added **${obj}** in **${zone}** (Ends at \`${utcTime} UTC\`).`, ephemeral: false });
        await updateDisplay();
    }

    if (i.commandName === 'clear') {
        db.prepare("DELETE FROM objectives").run();
        await i.reply({ content: "🗑️ All objectives cleared.", ephemeral: true });
        await updateDisplay();
    }
});

// --- 6. STARTUP ---

client.on('ready', async () => {
    console.log(`${client.user.tag} online!`);
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const commands = [
        new SlashCommandBuilder().setName('addobjectives').setDescription('Add a new objective')
            .addStringOption(o=>o.setName('obj').setRequired(true).setDescription('Type').setAutocomplete(true))
            .addStringOption(o=>o.setName('zone').setRequired(true).setDescription('Map').setAutocomplete(true))
            .addIntegerOption(o=>o.setName('hours').setRequired(true).setDescription('Hours'))
            .addIntegerOption(o=>o.setName('minutes').setRequired(true).setDescription('Minutes')),
        new SlashCommandBuilder().setName('clear').setDescription('Clear all objectives')
    ];

    try {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    } catch (e) { console.error(e); }

    setInterval(checkServerStatus, 60000); 
    setInterval(updateDisplay, 1800000); 
    checkServerStatus(); 
});

client.login(TOKEN);