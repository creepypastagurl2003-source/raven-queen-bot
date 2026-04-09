'use strict';

const {
  Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits,
  EmbedBuilder, REST, Routes, Partials,
} = require('discord.js');
const fs    = require('fs');
const path  = require('path');
const http  = require('http');
const https = require('https');

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN            = process.env.RAVEN_QUEEN_TOKEN;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID    || '';
const TWITCH_CLIENT_SEC = process.env.TWITCH_CLIENT_SECRET || '';
const YT_KEY           = process.env.YOUTUBE_API_KEY     || '';
const PORT             = parseInt(process.env.PORT || '5005', 10);

if (!TOKEN) throw new Error('RAVEN_QUEEN_TOKEN is not set.');

// ─── Data ─────────────────────────────────────────────────────────────────────
const DATA = path.join(__dirname, 'data');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const load = (file) => {
  const fp = path.join(DATA, file);
  if (!fs.existsSync(fp)) return {};
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
};

const save = (file, data) =>
  fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2));

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
const httpFetch = (url, opts = {}) => new Promise((res, rej) => {
  const lib = url.startsWith('https') ? https : http;
  const { method = 'GET', headers = {}, body } = opts;
  const req = lib.request(url, { method, headers, timeout: 10000 }, (r) => {
    let d = '';
    r.on('data', c => (d += c));
    r.on('end', () => res({ status: r.statusCode, body: d }));
  });
  req.on('error', rej);
  req.on('timeout', () => { req.destroy(); rej(new Error('Timeout')); });
  if (body) req.write(body);
  req.end();
});

const getJSON = async (url, opts = {}) => {
  try { const r = await httpFetch(url, opts); return JSON.parse(r.body); }
  catch { return null; }
};

// ─── Twitch helpers ───────────────────────────────────────────────────────────
let _twToken = null;

const getTwToken = async () => {
  if (_twToken) return _twToken;
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SEC) return null;
  const d = await getJSON(
    `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SEC}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  return (_twToken = d?.access_token || null);
};

const getLive = async (username) => {
  const tok = await getTwToken();
  if (!tok) return null;
  try {
    const r = await httpFetch(
      `https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(username)}`,
      { headers: { 'Client-ID': TWITCH_CLIENT_ID, Authorization: `Bearer ${tok}` } }
    );
    if (r.status === 401) { _twToken = null; return null; }
    return JSON.parse(r.body)?.data?.[0] || null;
  } catch { return null; }
};

// ─── YouTube helpers ──────────────────────────────────────────────────────────
const getLatestVid = async (channelId) => {
  try {
    const r = await httpFetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
    return r.body.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || null;
  } catch { return null; }
};

const resolveYT = async (input) => {
  input = input.trim().replace(/\/$/, '');
  const m = input.match(/(?:channel\/|^)(UC[A-Za-z0-9_-]{22})(?:$|\/|\?)/);
  if (m) return { id: m[1], title: m[1] };
  if (YT_KEY) {
    const hm = input.match(/@([A-Za-z0-9_.%-]+)/) || (input.startsWith('@') ? [null, input.slice(1)] : null);
    if (hm) {
      const d = await getJSON(`https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${hm[1]}&key=${YT_KEY}`);
      if (d?.items?.[0]) return { id: d.items[0].id, title: d.items[0].snippet.title };
    }
    const d = await getJSON(`https://www.googleapis.com/youtube/v3/channels?part=snippet&forUsername=${encodeURIComponent(input)}&key=${YT_KEY}`);
    if (d?.items?.[0]) return { id: d.items[0].id, title: d.items[0].snippet.title };
  }
  return null;
};

// ─── Client ───────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ─── Command definitions ──────────────────────────────────────────────────────
const CMDS = [
  new SlashCommandBuilder().setName('lock').setDescription('Restrict messaging in this channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('shadowlock').setDescription('Hide this channel from everyone.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('unlock').setDescription('Restore channel access and messaging.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('slowmode').setDescription('Set slowmode delay.')
    .addIntegerOption(o => o.setName('seconds').setDescription('Delay in seconds (0 = off)').setRequired(true).setMinValue(0).setMaxValue(21600))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('clear').setDescription('Delete messages from this channel.')
    .addIntegerOption(o => o.setName('amount').setDescription('Messages to delete (1–100)').setRequired(true).setMinValue(1).setMaxValue(100))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName('warn').setDescription('Issue a warning to a user.')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('mute').setDescription('Timeout a user.')
    .addUserOption(o => o.setName('user').setDescription('User to mute').setRequired(true))
    .addIntegerOption(o => o.setName('duration').setDescription('Duration in minutes (default: 10)').setMinValue(1).setMaxValue(40320))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('unmute').setDescription('Remove timeout from a user.')
    .addUserOption(o => o.setName('user').setDescription('User to unmute').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a user from the server.')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a user from the server.')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName('announce').setDescription('Send a royal announcement.')
    .addStringOption(o => o.setName('message').setDescription('Announcement text').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('decree').setDescription('Issue a decree.')
    .addStringOption(o => o.setName('message').setDescription('Decree text').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('observe').setDescription('Make your presence known.'),
  new SlashCommandBuilder().setName('summon').setDescription('Summon a role.')
    .addRoleOption(o => o.setName('role').setDescription('Role to summon').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('help').setDescription('View all Raven Queen commands.'),
  new SlashCommandBuilder().setName('birthday').setDescription('Birthday system.')
    .addSubcommand(s => s.setName('set').setDescription('Set your birthday.')
      .addIntegerOption(o => o.setName('month').setDescription('Month (1–12)').setRequired(true).setMinValue(1).setMaxValue(12))
      .addIntegerOption(o => o.setName('day').setDescription('Day (1–31)').setRequired(true).setMinValue(1).setMaxValue(31)))
    .addSubcommand(s => s.setName('view').setDescription('View a birthday.')
      .addUserOption(o => o.setName('user').setDescription('User (blank = yourself)')))
    .addSubcommand(s => s.setName('remove').setDescription('Remove your birthday.'))
    .addSubcommand(s => s.setName('list').setDescription('List all birthdays in this server.'))
    .addSubcommand(s => s.setName('channel').setDescription('Set birthday announcement channel. (Admin)')
      .addChannelOption(o => o.setName('channel').setDescription('Announcement channel').setRequired(true)))
    .addSubcommand(s => s.setName('role').setDescription('Set the birthday role. (Admin)')
      .addRoleOption(o => o.setName('role').setDescription('Role to assign on birthdays').setRequired(true)))
    .addSubcommand(s => s.setName('test').setDescription('Preview how your birthday announcement will look.')
      .addUserOption(o => o.setName('user').setDescription('User to test (Admin only; blank = yourself)')))
    .addSubcommandGroup(g => g.setName('message').setDescription('Manage your custom birthday message.')
      .addSubcommand(s => s.setName('set').setDescription('Set your custom birthday message.')
        .addStringOption(o => o.setName('text').setDescription('Your message (use {user} to mention them)').setRequired(true)))
      .addSubcommand(s => s.setName('view').setDescription('View your current custom message.'))
      .addSubcommand(s => s.setName('remove').setDescription('Remove your custom message.'))),
  new SlashCommandBuilder().setName('youtube').setDescription('YouTube upload notifications.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('set').setDescription('Subscribe to a YouTube channel.')
      .addStringOption(o => o.setName('channel').setDescription('YouTube channel URL or ID').setRequired(true))
      .addChannelOption(o => o.setName('discord_channel').setDescription('Discord channel for alerts').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a YouTube subscription.')
      .addStringOption(o => o.setName('channel').setDescription('YouTube channel ID').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List YouTube subscriptions.'))
    .addSubcommand(s => s.setName('channel').setDescription('Change the notification channel.')
      .addStringOption(o => o.setName('youtube_channel').setDescription('YouTube channel ID').setRequired(true))
      .addChannelOption(o => o.setName('discord_channel').setDescription('New Discord channel').setRequired(true)))
    .addSubcommand(s => s.setName('message').setDescription('Set a custom notification message.')
      .addStringOption(o => o.setName('youtube_channel').setDescription('YouTube channel ID').setRequired(true))
      .addStringOption(o => o.setName('text').setDescription('Message (use {url}, {title})').setRequired(true)))
    .addSubcommand(s => s.setName('toggle').setDescription('Enable or disable notifications.')
      .addStringOption(o => o.setName('youtube_channel').setDescription('YouTube channel ID').setRequired(true)))
    .addSubcommand(s => s.setName('test').setDescription('Send a test notification for a YouTube subscription.')
      .addStringOption(o => o.setName('youtube_channel').setDescription('YouTube channel ID').setRequired(true))),
  new SlashCommandBuilder().setName('twitch').setDescription('Twitch live notifications.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('set').setDescription('Subscribe to a Twitch streamer.')
      .addStringOption(o => o.setName('username').setDescription('Twitch username').setRequired(true))
      .addChannelOption(o => o.setName('discord_channel').setDescription('Discord channel for alerts').setRequired(true)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a Twitch subscription.')
      .addStringOption(o => o.setName('username').setDescription('Twitch username').setRequired(true)))
    .addSubcommand(s => s.setName('list').setDescription('List Twitch subscriptions.'))
    .addSubcommand(s => s.setName('channel').setDescription('Change the notification channel.')
      .addStringOption(o => o.setName('username').setDescription('Twitch username').setRequired(true))
      .addChannelOption(o => o.setName('discord_channel').setDescription('New Discord channel').setRequired(true)))
    .addSubcommand(s => s.setName('message').setDescription('Set a custom notification message.')
      .addStringOption(o => o.setName('username').setDescription('Twitch username').setRequired(true))
      .addStringOption(o => o.setName('text').setDescription('Message (use {url}, {game}, {viewers})').setRequired(true)))
    .addSubcommand(s => s.setName('toggle').setDescription('Enable or disable notifications.')
      .addStringOption(o => o.setName('username').setDescription('Twitch username').setRequired(true)))
    .addSubcommand(s => s.setName('test').setDescription('Send a test notification for a Twitch subscription.')
      .addStringOption(o => o.setName('username').setDescription('Twitch username').setRequired(true))),
  new SlashCommandBuilder().setName('silence').setDescription('Lock all channels in this category.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('unsilence').setDescription('Restore all channels in this category.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('case').setDescription('Manually log a moderation action.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
    .addStringOption(o => o.setName('type').setDescription('Action type').setRequired(true)
      .addChoices(
        { name: 'warn', value: 'warn' },
        { name: 'mute', value: 'mute' },
        { name: 'ban', value: 'ban' },
        { name: 'kick', value: 'kick' },
        { name: 'note', value: 'note' },
      ))
    .addStringOption(o => o.setName('reason').setDescription('Reason').setRequired(true)),
  new SlashCommandBuilder().setName('history').setDescription('Show moderation history for a user.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),
  new SlashCommandBuilder().setName('watch').setDescription('Mark a user for monitoring.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason for watching')),
  new SlashCommandBuilder().setName('unwatch').setDescription('Remove a user from monitoring.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),
  new SlashCommandBuilder().setName('cleanse').setDescription('Delete recent bot and system messages.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName('userinfo').setDescription('Show information about a user.')
    .addUserOption(o => o.setName('user').setDescription('Target user (defaults to you)')),
  new SlashCommandBuilder().setName('roleinfo').setDescription('Show information about a role.')
    .addRoleOption(o => o.setName('role').setDescription('Target role').setRequired(true)),
  new SlashCommandBuilder().setName('afk').setDescription('Set your AFK status.')
    .addStringOption(o => o.setName('message').setDescription('AFK message (optional)')),
  new SlashCommandBuilder().setName('return').setDescription('Remove your AFK status.'),
  new SlashCommandBuilder().setName('bless').setDescription('Bestow the Queen\'s favour upon a user.')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),
  new SlashCommandBuilder().setName('curse').setDescription('Lay a curse upon a user.')
    .addUserOption(o => o.setName('user').setDescription('Target user').setRequired(true)),
  new SlashCommandBuilder().setName('poll').setDescription('Poll system.')
    .addSubcommand(s => s.setName('create').setDescription('Create a new poll.')
      .addStringOption(o => o.setName('question').setDescription('The poll question').setRequired(true))
      .addStringOption(o => o.setName('option1').setDescription('First option').setRequired(true))
      .addStringOption(o => o.setName('option2').setDescription('Second option').setRequired(true))
      .addStringOption(o => o.setName('option3').setDescription('Third option'))
      .addStringOption(o => o.setName('option4').setDescription('Fourth option'))
      .addStringOption(o => o.setName('option5').setDescription('Fifth option')))
    .addSubcommand(s => s.setName('end').setDescription('End the current poll and announce the winner.'))
    .addSubcommand(s => s.setName('results').setDescription('Show current vote counts.')),
].map(c => c.toJSON());

// ─── on_ready ─────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[Raven Queen] 👑 Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    const guilds = client.guilds.cache.map(g => g.id);
    if (guilds.length === 0) {
      await rest.put(Routes.applicationCommands(client.user.id), { body: CMDS });
      console.log(`[Raven Queen] No guilds found — registered ${CMDS.length} commands globally.`);
    } else {
      for (const guildId of guilds) {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: CMDS });
      }
      console.log(`[Raven Queen] Cleared global commands. Registered ${CMDS.length} commands in ${guilds.length} guild(s) instantly.`);
    }
  } catch (e) {
    console.error('[Raven Queen] Command registration failed:', e.message);
  }
  checkBirthdays();
  setInterval(checkBirthdays, 60 * 60 * 1000);
  checkYouTube();
  setInterval(checkYouTube, 10 * 60 * 1000);
  checkTwitch();
  setInterval(checkTwitch, 2 * 60 * 1000);
});

// ─── Interaction handler ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    switch (interaction.commandName) {
      case 'lock':       return await handleLock(interaction);
      case 'shadowlock': return await handleShadowlock(interaction);
      case 'unlock':     return await handleUnlock(interaction);
      case 'slowmode':   return await handleSlowmode(interaction);
      case 'clear':      return await handleClear(interaction);
      case 'warn':       return await handleWarn(interaction);
      case 'mute':       return await handleMute(interaction);
      case 'unmute':     return await handleUnmute(interaction);
      case 'ban':        return await handleBan(interaction);
      case 'kick':       return await handleKick(interaction);
      case 'announce':   return await handleAnnounce(interaction);
      case 'decree':     return await handleDecree(interaction);
      case 'observe':    return await handleObserve(interaction);
      case 'summon':     return await handleSummon(interaction);
      case 'help':       return await handleHelp(interaction);
      case 'birthday':   return await handleBirthday(interaction);
      case 'youtube':    return await handleYouTube(interaction);
      case 'twitch':     return await handleTwitch(interaction);
      case 'poll':       return await handlePoll(interaction);
      case 'silence':    return await handleSilence(interaction);
      case 'unsilence':  return await handleUnsilence(interaction);
      case 'case':       return await handleCase(interaction);
      case 'history':    return await handleHistory(interaction);
      case 'watch':      return await handleWatch(interaction);
      case 'unwatch':    return await handleUnwatch(interaction);
      case 'cleanse':    return await handleCleanse(interaction);
      case 'userinfo':   return await handleUserinfo(interaction);
      case 'roleinfo':   return await handleRoleinfo(interaction);
      case 'afk':        return await handleAfk(interaction);
      case 'return':     return await handleReturn(interaction);
      case 'bless':      return await handleBless(interaction);
      case 'curse':      return await handleCurse(interaction);
    }
  } catch (e) {
    console.error(`[Error] /${interaction.commandName}:`, e.message);
    const msg = { content: '🖤 An error occurred in the shadows.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

// ─── Moderation ───────────────────────────────────────────────────────────────
async function handleLock(i) {
  await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: false });
  await i.reply('👑🪶 This channel is now under restriction.\n👁️ You may observe… but not speak.');
}

async function handleShadowlock(i) {
  await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { ViewChannel: false });
  await i.reply({ content: '👑🪶 This place has been taken by the shadows.\n👁️ You were not meant to remain.', ephemeral: true });
}

async function handleUnlock(i) {
  await i.channel.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: null, ViewChannel: null });
  await i.reply('👑🪶 The restriction has been lifted.\n🖤 You may speak again.');
}

async function handleSlowmode(i) {
  const secs = i.options.getInteger('seconds');
  await i.channel.setRateLimitPerUser(secs);
  await i.reply(`👑🪶 The pace has been controlled.\n👁️ Speak carefully.`);
}

async function handleClear(i) {
  const amount = i.options.getInteger('amount');
  await i.deferReply({ ephemeral: true });
  const deleted = await i.channel.bulkDelete(amount, true);
  await i.editReply(`👑🪶 The past has been erased. (${deleted.size} messages removed)`);
}

// ─── User actions ─────────────────────────────────────────────────────────────
async function handleWarn(i) {
  const user   = i.options.getUser('user');
  const reason = i.options.getString('reason') || 'No reason given.';
  const warns  = load('warnings.json');
  const gid    = i.guild.id;
  if (!warns[gid]) warns[gid] = {};
  if (!warns[gid][user.id]) warns[gid][user.id] = [];
  warns[gid][user.id].push({ reason, date: new Date().toISOString(), by: i.user.id });
  save('warnings.json', warns);
  const count = warns[gid][user.id].length;
  await i.reply(`👑🪶 ${user} has been warned.\n🖤 Reason: ${reason}\n👁️ Warning #${count}.`);
}

async function handleMute(i) {
  const member = i.options.getMember('user');
  const mins   = i.options.getInteger('duration') || 10;
  const reason = i.options.getString('reason') || 'No reason given.';
  await member.timeout(mins * 60 * 1000, reason);
  await i.reply(`👑🪶 ${member} has been silenced for ${mins} minute(s).\n🖤 ${reason}`);
}

async function handleUnmute(i) {
  const member = i.options.getMember('user');
  await member.timeout(null);
  await i.reply(`👑🪶 ${member}'s silence has been lifted.\n🖤 Do not make this a habit.`);
}

async function handleBan(i) {
  const user   = i.options.getUser('user');
  const reason = i.options.getString('reason') || 'No reason given.';
  await i.guild.members.ban(user, { reason });
  await i.reply(`👑🪶 ${user.tag} has been exiled.\n🖤 ${reason}`);
}

async function handleKick(i) {
  const member = i.options.getMember('user');
  const reason = i.options.getString('reason') || 'No reason given.';
  await member.kick(reason);
  await i.reply(`👑🪶 ${member.user.tag} has been removed.\n🖤 ${reason}`);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
async function handleAnnounce(i) {
  const msg = i.options.getString('message');
  await i.reply(`👑🪶 A decree has been issued…\n${msg}`);
}

async function handleDecree(i) {
  const msg = i.options.getString('message');
  await i.reply(`👑🪶 ${msg}`);
}

async function handleObserve(i) {
  await i.reply('👑🪶 I am watching.');
}

async function handleSummon(i) {
  const role = i.options.getRole('role');
  await i.reply(`👑🪶 ${role} — you have been summoned.\n👁️ Do not ignore the call.`);
}

// ─── Help ─────────────────────────────────────────────────────────────────────
async function handleHelp(i) {
  const main = new EmbedBuilder()
    .setTitle('👑🪶 Raven Queen — Command Guide')
    .setColor(0x2B0040)
    .setDescription('*All who serve the Queen shall know the laws of the realm.*')
    .addFields(
      {
        name: '🎂 Birthdays  *(available to all members)*',
        value: [
          '`/birthday set` — Register your birthday',
          '`/birthday view` — View yours or another member\'s',
          '`/birthday remove` — Remove your birthday',
          '`/birthday list` — See all server birthdays',
          '`/birthday message set/view/remove` — Custom birthday message',
        ].join('\n'),
      },
      {
        name: '🎉 AFK  *(available to all members)*',
        value: [
          '`/afk [message]` — Set your AFK status',
          '`/return` — Clear your AFK status',
        ].join('\n'),
      },
      {
        name: '✨ Aesthetic  *(available to all members)*',
        value: '`/bless` `/curse` — Bestow favour or lay a shadow upon a user',
      },
    )
    .setFooter({ text: 'I am always watching… 👁️' });

  const mod = new EmbedBuilder()
    .setColor(0x2B0040)
    .addFields(
      {
        name: '👑 Channel Control  *(Manage Channels)*',
        value: [
          '`/lock` — Lock this channel',
          '`/shadowlock` — Lock silently',
          '`/unlock` — Unlock this channel',
          '`/slowmode [seconds]` — Set slowmode',
          '`/silence` — Lock all channels in this category',
          '`/unsilence` — Restore all channels in this category',
        ].join('\n'),
      },
      {
        name: '⚖️ User Actions  *(Moderate Members)*',
        value: [
          '`/warn` — Issue a warning',
          '`/mute` — Timeout a member',
          '`/unmute` — Remove timeout',
          '`/ban` — Ban a member',
          '`/kick` — Kick a member',
        ].join('\n'),
      },
      {
        name: '📋 Mod Logs  *(Moderate Members)*',
        value: [
          '`/case` — Manually log a mod action (warn/mute/ban/kick/note)',
          '`/history` — View full mod history for a user',
          '`/watch` — Mark a user for monitoring',
          '`/unwatch` — Remove monitoring',
        ].join('\n'),
      },
      {
        name: '🧹 Cleanup  *(Manage Messages)*',
        value: [
          '`/clear [amount]` — Bulk delete messages',
          '`/cleanse` — Remove recent bot & system messages',
        ].join('\n'),
      },
    )
    .setFooter({ text: 'I am always watching… 👁️' });

  const util = new EmbedBuilder()
    .setColor(0x2B0040)
    .addFields(
      {
        name: '🔍 Info  *(everyone)*',
        value: [
          '`/userinfo [user]` — Member details, roles, and mod records',
          '`/roleinfo <role>` — Role colour, members, permissions',
        ].join('\n'),
      },
      {
        name: '📢 Announcements  *(Manage Guild)*',
        value: [
          '`/announce` — Post a server announcement',
          '`/decree` — Issue a royal decree',
          '`/observe` — Observe channel activity',
          '`/summon` — Summon a member\'s attention',
        ].join('\n'),
      },
      {
        name: '📊 Polls  *(Manage Guild)*',
        value: [
          '`/poll create` — Start a new poll (2–5 options)',
          '`/poll results` — Show live vote counts',
          '`/poll end` — Close poll and announce the winner',
        ].join('\n'),
      },
      {
        name: '🎥 YouTube Notifications  *(Manage Guild)*',
        value: '`/youtube set/remove/list/channel/message/toggle/test`',
      },
      {
        name: '🎮 Twitch Notifications  *(Manage Guild)*',
        value: '`/twitch set/remove/list/channel/message/toggle/test`',
      },
      {
        name: '🎂 Birthday Config  *(Manage Guild)*',
        value: '`/birthday channel` `/birthday role` — Set announcement channel & role',
      },
    )
    .setFooter({ text: 'I am always watching… 👁️' });

  await i.reply({ embeds: [main, mod, util] });
}

// ─── Birthday ─────────────────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function handleBirthday(i) {
  const group = i.options.getSubcommandGroup(false);
  const sub   = i.options.getSubcommand(false);
  const gid   = i.guild.id;
  const uid   = i.user.id;
  const bdays = load('birthdays.json');
  const cfg   = load('birthday_config.json');
  if (!bdays[gid]) bdays[gid] = {};
  if (!cfg[gid])   cfg[gid]   = {};

  if (group === 'message') {
    if (sub === 'set') {
      const text = i.options.getString('text');
      if (!bdays[gid][uid]) return i.reply({ content: '🖤 Set your birthday first with `/birthday set`.', ephemeral: true });
      bdays[gid][uid].custom_message = text;
      save('birthdays.json', bdays);
      return i.reply({ content: `👑🪶 Your custom birthday message has been set.\n> ${text}`, ephemeral: true });
    }
    if (sub === 'view') {
      const msg = bdays[gid][uid]?.custom_message;
      if (!msg) return i.reply({ content: '🖤 You have no custom birthday message set.', ephemeral: true });
      return i.reply({ content: `👑🪶 Your message:\n> ${msg}`, ephemeral: true });
    }
    if (sub === 'remove') {
      if (bdays[gid][uid]) delete bdays[gid][uid].custom_message;
      save('birthdays.json', bdays);
      return i.reply({ content: '🖤 Custom birthday message removed.', ephemeral: true });
    }
  }

  if (sub === 'set') {
    const month = i.options.getInteger('month');
    const day   = i.options.getInteger('day');
    bdays[gid][uid] = { ...(bdays[gid][uid] || {}), month, day };
    save('birthdays.json', bdays);
    return i.reply({ content: `👑🪶 Your birthday has been set to **${MONTHS[month - 1]} ${day}**.\n🖤 I will remember.`, ephemeral: true });
  }

  if (sub === 'view') {
    const target = i.options.getUser('user') || i.user;
    const data   = bdays[gid][target.id];
    if (!data) return i.reply({ content: `🖤 ${target.id === uid ? 'You have' : `${target.tag} has`} no birthday set.`, ephemeral: true });
    return i.reply({ content: `👑🪶 **${target.tag}**'s birthday: **${MONTHS[data.month - 1]} ${data.day}**`, ephemeral: true });
  }

  if (sub === 'remove') {
    delete bdays[gid][uid];
    save('birthdays.json', bdays);
    return i.reply({ content: '🖤 Your birthday has been removed from my records.', ephemeral: true });
  }

  if (sub === 'test') {
    const isAdmin = i.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const target  = (isAdmin && i.options.getUser('user')) || i.user;
    const data    = bdays[gid][target.id];
    const member  = await i.guild.members.fetch(target.id).catch(() => null);
    if (!member) return i.reply({ content: '🖤 Could not find that member.', ephemeral: true });

    const defaultMsg = `👑🪶 A new cycle begins for {user}.\n🖤 You've made it this far… that matters.`;
    let msg = (data?.custom_message || cfg[gid]?.message || defaultMsg).replace(/\{user\}/g, member.toString());
    if (!msg.includes(member.toString())) msg = `${member} ${msg}`;

    return i.reply({ content: `👁️ **Birthday message preview for ${target.tag}:**\n\n${msg}`, ephemeral: true });
  }

  if (sub === 'list') {
    const entries = Object.entries(bdays[gid]).filter(([, d]) => d.month && d.day);
    if (!entries.length) return i.reply({ content: '🖤 No birthdays recorded in this server.', ephemeral: true });
    const sorted = entries.sort(([, a], [, b]) => a.month !== b.month ? a.month - b.month : a.day - b.day);
    const lines  = sorted.map(([id, d]) => `<@${id}> — ${MONTHS[d.month - 1]} ${d.day}`);
    const embed  = new EmbedBuilder()
      .setTitle('👑🪶 Birthdays')
      .setColor(0x2B0040)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'I am always watching… 👁️' });
    return i.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'channel') {
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild))
      return i.reply({ content: '🖤 You need **Manage Server** permission.', ephemeral: true });
    const ch = i.options.getChannel('channel');
    cfg[gid].channel = ch.id;
    save('birthday_config.json', cfg);
    return i.reply({ content: `👑🪶 Birthday announcements will appear in ${ch}.`, ephemeral: true });
  }

  if (sub === 'role') {
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild))
      return i.reply({ content: '🖤 You need **Manage Server** permission.', ephemeral: true });
    const role = i.options.getRole('role');
    cfg[gid].role = role.id;
    save('birthday_config.json', cfg);
    return i.reply({ content: `👑🪶 Birthday role set to ${role}.`, ephemeral: true });
  }
}

// ─── YouTube ──────────────────────────────────────────────────────────────────
const YT_DEFAULT = `👑🪶 A signal emerges from the shadows… 👁️✨\n\n🎥 Watch now\n🖤 Show your presence\n\n🦇 {url}\n\n👁️ You were meant to find this.`;

async function handleYouTube(i) {
  await i.deferReply({ ephemeral: true });
  const sub = i.options.getSubcommand();
  const gid = i.guild.id;
  const yt  = load('youtube.json');
  if (!yt[gid]) yt[gid] = {};

  if (sub === 'set') {
    const input = i.options.getString('channel');
    const dcCh  = i.options.getChannel('discord_channel');
    const ch    = await resolveYT(input);
    if (!ch) return i.editReply('🖤 Could not resolve that YouTube channel. Try providing the channel ID directly (starts with `UC`).');
    if (yt[gid][ch.id]) return i.editReply(`🖤 Already subscribed to **${ch.title}**.`);
    const lastVid = await getLatestVid(ch.id);
    yt[gid][ch.id] = { title: ch.title, discord_channel: dcCh.id, message: YT_DEFAULT, enabled: true, last_video_id: lastVid };
    save('youtube.json', yt);
    return i.editReply(`👑🪶 Now watching **${ch.title}**.\n🖤 Alerts will appear in ${dcCh}.`);
  }

  if (sub === 'remove') {
    const id = i.options.getString('channel');
    if (!yt[gid][id]) return i.editReply('🖤 No subscription found with that ID.');
    const title = yt[gid][id].title;
    delete yt[gid][id];
    save('youtube.json', yt);
    return i.editReply(`👑🪶 Removed subscription for **${title}**.`);
  }

  if (sub === 'list') {
    const subs = Object.entries(yt[gid]);
    if (!subs.length) return i.editReply('🖤 No YouTube subscriptions in this server.');
    const lines = subs.map(([id, d]) => `**${d.title}** — <#${d.discord_channel}> ${d.enabled ? '✅' : '❌'}\n\`${id}\``);
    return i.editReply(`👑🪶 **YouTube Subscriptions:**\n${lines.join('\n\n')}`);
  }

  if (sub === 'channel') {
    const id   = i.options.getString('youtube_channel');
    const dcCh = i.options.getChannel('discord_channel');
    if (!yt[gid][id]) return i.editReply('🖤 No subscription found with that ID.');
    yt[gid][id].discord_channel = dcCh.id;
    save('youtube.json', yt);
    return i.editReply(`👑🪶 Alerts for **${yt[gid][id].title}** will now go to ${dcCh}.`);
  }

  if (sub === 'message') {
    const id   = i.options.getString('youtube_channel');
    const text = i.options.getString('text');
    if (!yt[gid][id]) return i.editReply('🖤 No subscription found with that ID.');
    yt[gid][id].message = text;
    save('youtube.json', yt);
    return i.editReply(`👑🪶 Custom message set for **${yt[gid][id].title}**.`);
  }

  if (sub === 'toggle') {
    const id = i.options.getString('youtube_channel');
    if (!yt[gid][id]) return i.editReply('🖤 No subscription found with that ID.');
    yt[gid][id].enabled = !yt[gid][id].enabled;
    save('youtube.json', yt);
    return i.editReply(`👑🪶 **${yt[gid][id].title}** notifications ${yt[gid][id].enabled ? 'enabled ✅' : 'disabled ❌'}.`);
  }

  if (sub === 'test') {
    const id = i.options.getString('youtube_channel');
    if (!yt[gid][id]) return i.editReply('🖤 No subscription found with that ID.');
    const sub_data = yt[gid][id];
    const vidId = await getLatestVid(id);
    if (!vidId) return i.editReply('🖤 Could not fetch a video from that channel right now. The RSS feed may be unavailable.');
    const url = `https://www.youtube.com/watch?v=${vidId}`;
    const msg = (sub_data.message || YT_DEFAULT).replace(/\{url\}/g, url).replace(/\{title\}/g, sub_data.title);
    const ch = i.guild.channels.cache.get(sub_data.discord_channel);
    if (!ch) return i.editReply('🖤 The configured notification channel no longer exists. Update it with `/youtube channel`.');
    await ch.send(msg);
    return i.editReply(`👑🪶 Test notification sent to ${ch}.\n👁️ ⚙️ *This was a test — no subscription data was changed.*`);
  }
}

// ─── Twitch ───────────────────────────────────────────────────────────────────
const TW_DEFAULT = `👑🪶 A presence has gone live… 👁️✨\n\n🎮 Enter if you dare\n🖤 Stay a while\n\n🦇 {url}\n\n🩸 Don't keep me waiting.`;

async function handleTwitch(i) {
  await i.deferReply({ ephemeral: true });
  const sub = i.options.getSubcommand();
  const gid = i.guild.id;
  const tw  = load('twitch.json');
  if (!tw[gid]) tw[gid] = {};

  if (sub === 'set') {
    const username = i.options.getString('username').toLowerCase().trim();
    const dcCh     = i.options.getChannel('discord_channel');
    if (tw[gid][username]) return i.editReply(`🖤 Already subscribed to **${username}**.`);
    tw[gid][username] = { discord_channel: dcCh.id, message: TW_DEFAULT, enabled: true, is_live: false };
    save('twitch.json', tw);
    return i.editReply(`👑🪶 Now watching **${username}** on Twitch.\n🖤 Alerts will appear in ${dcCh}.`);
  }

  if (sub === 'remove') {
    const username = i.options.getString('username').toLowerCase();
    if (!tw[gid][username]) return i.editReply('🖤 No subscription found for that username.');
    delete tw[gid][username];
    save('twitch.json', tw);
    return i.editReply(`👑🪶 Removed Twitch subscription for **${username}**.`);
  }

  if (sub === 'list') {
    const subs = Object.entries(tw[gid]);
    if (!subs.length) return i.editReply('🖤 No Twitch subscriptions in this server.');
    const lines = subs.map(([u, d]) => `**${u}** — <#${d.discord_channel}> ${d.enabled ? '✅' : '❌'} ${d.is_live ? '🔴 LIVE' : ''}`);
    return i.editReply(`👑🪶 **Twitch Subscriptions:**\n${lines.join('\n')}`);
  }

  if (sub === 'channel') {
    const username = i.options.getString('username').toLowerCase();
    const dcCh     = i.options.getChannel('discord_channel');
    if (!tw[gid][username]) return i.editReply('🖤 No subscription found for that username.');
    tw[gid][username].discord_channel = dcCh.id;
    save('twitch.json', tw);
    return i.editReply(`👑🪶 Alerts for **${username}** will now go to ${dcCh}.`);
  }

  if (sub === 'message') {
    const username = i.options.getString('username').toLowerCase();
    const text     = i.options.getString('text');
    if (!tw[gid][username]) return i.editReply('🖤 No subscription found for that username.');
    tw[gid][username].message = text;
    save('twitch.json', tw);
    return i.editReply(`👑🪶 Custom message set for **${username}**.`);
  }

  if (sub === 'toggle') {
    const username = i.options.getString('username').toLowerCase();
    if (!tw[gid][username]) return i.editReply('🖤 No subscription found for that username.');
    tw[gid][username].enabled = !tw[gid][username].enabled;
    save('twitch.json', tw);
    return i.editReply(`👑🪶 **${username}** notifications ${tw[gid][username].enabled ? 'enabled ✅' : 'disabled ❌'}.`);
  }

  if (sub === 'test') {
    const username = i.options.getString('username').toLowerCase();
    if (!tw[gid][username]) return i.editReply('🖤 No subscription found for that username.');
    const sub_data = tw[gid][username];
    const url = `https://twitch.tv/${username}`;
    const msg = (sub_data.message || TW_DEFAULT)
      .replace(/\{url\}/g, url)
      .replace(/\{game\}/g, 'Test Game')
      .replace(/\{viewers\}/g, '0');
    const ch = i.guild.channels.cache.get(sub_data.discord_channel);
    if (!ch) return i.editReply('🖤 The configured notification channel no longer exists. Update it with `/twitch channel`.');
    await ch.send(msg);
    return i.editReply(`👑🪶 Test notification sent to ${ch}.\n👁️ ⚙️ *This was a test — no live status was changed.*`);
  }
}

// ─── Background: Birthdays ────────────────────────────────────────────────────
async function checkBirthdays() {
  try {
    const bdays = load('birthdays.json');
    const cfg   = load('birthday_config.json');
    const now   = new Date();
    const month = now.getUTCMonth() + 1;
    const day   = now.getUTCDate();

    for (const [gid, users] of Object.entries(bdays)) {
      const gc = cfg[gid] || {};
      if (!gc.channel) continue;
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      const ch = guild.channels.cache.get(gc.channel);
      if (!ch) continue;
      if (!gc.announced) gc.announced = {};

      // Remove birthday roles after 24 hours
      if (gc.role) {
        for (const [uid, ts] of Object.entries(gc.announced)) {
          if (Date.now() - ts < 86400000) continue;
          const m = guild.members.cache.get(uid) || await guild.members.fetch(uid).catch(() => null);
          if (m?.roles.cache.has(gc.role)) await m.roles.remove(gc.role).catch(() => {});
          delete gc.announced[uid];
        }
        cfg[gid] = gc;
        save('birthday_config.json', cfg);
      }

      // Announce birthdays for today
      for (const [uid, data] of Object.entries(users)) {
        if (data.month !== month || data.day !== day) continue;
        if (gc.announced[uid] && Date.now() - gc.announced[uid] < 86400000) continue;
        const member = guild.members.cache.get(uid) || await guild.members.fetch(uid).catch(() => null);
        if (!member) continue;
        const defaultMsg = `👑🪶 A new cycle begins for {user}.\n🖤 You've made it this far… that matters.`;
        let msg = (data.custom_message || gc.message || defaultMsg).replace(/\{user\}/g, member.toString());
        if (!msg.includes(member.toString())) msg = `${member} ${msg}`;
        await ch.send(msg).catch(() => {});
        if (gc.role) await member.roles.add(gc.role).catch(() => {});
        if (!cfg[gid]) cfg[gid] = {};
        if (!cfg[gid].announced) cfg[gid].announced = {};
        cfg[gid].announced[uid] = Date.now();
        save('birthday_config.json', cfg);
      }
    }
  } catch (e) {
    console.error('[Birthday check error]', e.message);
  }
}

// ─── Background: YouTube ──────────────────────────────────────────────────────
async function checkYouTube() {
  try {
    const yt = load('youtube.json');
    let changed = false;
    for (const [gid, subs] of Object.entries(yt)) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      for (const [channelId, sub] of Object.entries(subs)) {
        if (!sub.enabled) continue;
        const vidId = await getLatestVid(channelId);
        if (!vidId || vidId === sub.last_video_id) continue;
        yt[gid][channelId].last_video_id = vidId;
        changed = true;
        const url = `https://www.youtube.com/watch?v=${vidId}`;
        const msg = (sub.message || YT_DEFAULT).replace(/\{url\}/g, url).replace(/\{title\}/g, sub.title);
        const ch = guild.channels.cache.get(sub.discord_channel);
        if (ch) await ch.send(msg).catch(() => {});
      }
    }
    if (changed) save('youtube.json', yt);
  } catch (e) {
    console.error('[YouTube check error]', e.message);
  }
}

// ─── Background: Twitch ───────────────────────────────────────────────────────
async function checkTwitch() {
  try {
    const tw = load('twitch.json');
    let changed = false;
    for (const [gid, subs] of Object.entries(tw)) {
      const guild = client.guilds.cache.get(gid);
      if (!guild) continue;
      for (const [username, sub] of Object.entries(subs)) {
        if (!sub.enabled) continue;
        const stream = await getLive(username);
        const isLive = !!stream;
        if (isLive && !sub.is_live) {
          tw[gid][username].is_live = true;
          changed = true;
          const url = `https://twitch.tv/${username}`;
          const msg = (sub.message || TW_DEFAULT)
            .replace(/\{url\}/g, url)
            .replace(/\{game\}/g, stream.game_name || 'Unknown')
            .replace(/\{viewers\}/g, stream.viewer_count || 0);
          const ch = guild.channels.cache.get(sub.discord_channel);
          if (ch) await ch.send(msg).catch(() => {});
        } else if (!isLive && sub.is_live) {
          tw[gid][username].is_live = false;
          changed = true;
        }
      }
    }
    if (changed) save('twitch.json', tw);
  } catch (e) {
    console.error('[Twitch check error]', e.message);
  }
}

// ─── Silence / Unsilence ──────────────────────────────────────────────────────
async function handleSilence(i) {
  await i.deferReply();
  const everyoneRole = i.guild.roles.everyone;
  const channels = i.channel.parentId
    ? i.guild.channels.cache.filter(c => c.parentId === i.channel.parentId && c.isTextBased())
    : i.guild.channels.cache.filter(c => c.isTextBased());

  let count = 0;
  for (const [, ch] of channels) {
    await ch.permissionOverwrites.edit(everyoneRole, { SendMessages: false }).catch(() => {});
    count++;
  }
  return i.editReply(`👑🪶 Silence has been enforced.\n👁️ Let the noise end.\n\n*${count} channel(s) locked.*`);
}

async function handleUnsilence(i) {
  await i.deferReply();
  const everyoneRole = i.guild.roles.everyone;
  const channels = i.channel.parentId
    ? i.guild.channels.cache.filter(c => c.parentId === i.channel.parentId && c.isTextBased())
    : i.guild.channels.cache.filter(c => c.isTextBased());

  let count = 0;
  for (const [, ch] of channels) {
    await ch.permissionOverwrites.edit(everyoneRole, { SendMessages: null }).catch(() => {});
    count++;
  }
  return i.editReply(`👑🪶 The silence fades…\n🖤 Speak, carefully.\n\n*${count} channel(s) restored.*`);
}

// ─── Case log ─────────────────────────────────────────────────────────────────
async function handleCase(i) {
  const target = i.options.getUser('user');
  const type   = i.options.getString('type');
  const reason = i.options.getString('reason');
  const cases  = load('cases.json');
  const gid    = i.guild.id;
  if (!cases[gid]) cases[gid] = [];

  const entry = {
    id:          cases[gid].length + 1,
    type,
    user_id:     target.id,
    user_tag:    target.tag,
    mod_id:      i.user.id,
    mod_tag:     i.user.tag,
    reason,
    timestamp:   new Date().toISOString(),
  };
  cases[gid].push(entry);
  save('cases.json', cases);
  return i.reply(`👑🪶 A record has been written.\n\n🖤 **Case #${entry.id}** — \`${type.toUpperCase()}\`\n👤 ${target.tag}\n📝 ${reason}`);
}

// ─── History ──────────────────────────────────────────────────────────────────
async function handleHistory(i) {
  const target   = i.options.getUser('user');
  const gid      = i.guild.id;
  const cases    = load('cases.json');
  const warnings = load('warnings.json');

  const userCases = (cases[gid] || []).filter(c => c.user_id === target.id);
  const userWarns = (warnings[gid]?.[target.id] || []);

  if (userCases.length === 0 && userWarns.length === 0) {
    return i.reply({ content: `👑🪶 Their past is not forgotten. 👁️\n\n🖤 No records found for **${target.tag}**.`, ephemeral: true });
  }

  const caseLines = userCases.map(c =>
    `• **Case #${c.id}** \`${c.type.toUpperCase()}\` — ${c.reason} *(${new Date(c.timestamp).toLocaleDateString()})*`
  );
  const warnLines = userWarns.map((w, idx) =>
    `• **Warn #${idx + 1}** — ${w.reason} *(${new Date(w.timestamp).toLocaleDateString()})*`
  );

  const all = [...warnLines, ...caseLines];
  const out = all.slice(0, 20).join('\n') + (all.length > 20 ? `\n*…and ${all.length - 20} more.*` : '');
  return i.reply({ content: `👑🪶 Their past is not forgotten. 👁️\n\n👤 **${target.tag}**\n\n${out}`, ephemeral: true });
}

// ─── Watch / Unwatch ──────────────────────────────────────────────────────────
async function handleWatch(i) {
  const target = i.options.getUser('user');
  const reason = i.options.getString('reason') || 'No reason given.';
  const gid    = i.guild.id;
  const watched = load('watched.json');
  if (!watched[gid]) watched[gid] = {};

  watched[gid][target.id] = { tag: target.tag, reason, since: new Date().toISOString(), mod: i.user.tag };
  save('watched.json', watched);
  return i.reply({ content: `👑🪶 You are being observed.\n\n👁️ **${target.tag}** has been marked for monitoring.\n📝 ${reason}`, ephemeral: true });
}

async function handleUnwatch(i) {
  const target  = i.options.getUser('user');
  const gid     = i.guild.id;
  const watched = load('watched.json');
  if (!watched[gid]?.[target.id]) {
    return i.reply({ content: `🖤 **${target.tag}** is not currently being watched.`, ephemeral: true });
  }
  delete watched[gid][target.id];
  save('watched.json', watched);
  return i.reply({ content: `👑🪶 You are no longer under watch.\n\n🖤 **${target.tag}** has been removed from monitoring.`, ephemeral: true });
}

// ─── Cleanse ──────────────────────────────────────────────────────────────────
async function handleCleanse(i) {
  await i.deferReply({ ephemeral: true });
  const messages = await i.channel.messages.fetch({ limit: 100 });
  const toDelete = messages.filter(m =>
    m.author.bot || m.type === 6 || m.type === 7 || m.type === 8 || m.type === 3
  );
  let deleted = 0;
  for (const [, m] of toDelete) {
    await m.delete().catch(() => {});
    deleted++;
  }
  return i.editReply(`👑🪶 The space has been purified.\n🖤 *${deleted} message(s) removed.*`);
}

// ─── Userinfo ─────────────────────────────────────────────────────────────────
async function handleUserinfo(i) {
  const target = i.options.getUser('user') || i.user;
  const member = await i.guild.members.fetch(target.id).catch(() => null);
  const watched = load('watched.json');
  const cases   = load('cases.json');
  const warnings = load('warnings.json');
  const gid = i.guild.id;

  const isWatched  = !!watched[gid]?.[target.id];
  const caseCount  = (cases[gid] || []).filter(c => c.user_id === target.id).length;
  const warnCount  = (warnings[gid]?.[target.id] || []).length;
  const roles      = member ? member.roles.cache.filter(r => r.id !== i.guild.id).map(r => `<@&${r.id}>`).join(', ') || 'None' : 'N/A';
  const joined     = member?.joinedAt ? `<t:${Math.floor(member.joinedAt / 1000)}:D>` : 'Unknown';
  const created    = `<t:${Math.floor(target.createdTimestamp / 1000)}:D>`;

  const embed = new EmbedBuilder()
    .setColor(0x2b0a3d)
    .setTitle(`👑 ${target.tag}`)
    .setThumbnail(target.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: '🆔 User ID',       value: target.id,      inline: true },
      { name: '📅 Account created', value: created,       inline: true },
      { name: '📥 Joined server',  value: joined,         inline: true },
      { name: '🎭 Roles',          value: roles.slice(0, 1024) },
      { name: '⚖️ Mod records',    value: `${warnCount} warn(s) • ${caseCount} case(s)`, inline: true },
      { name: '👁️ Watched',        value: isWatched ? 'Yes 🔴' : 'No',                  inline: true },
    )
    .setFooter({ text: '👁️ The Queen sees all.' });

  return i.reply({ embeds: [embed], ephemeral: true });
}

// ─── Roleinfo ─────────────────────────────────────────────────────────────────
async function handleRoleinfo(i) {
  const role    = i.options.getRole('role');
  const members = i.guild.members.cache.filter(m => m.roles.cache.has(role.id)).size;
  const created = `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`;
  const hex     = role.hexColor;
  const perms   = role.permissions.toArray().slice(0, 8).join(', ') || 'None';

  const embed = new EmbedBuilder()
    .setColor(role.color || 0x2b0a3d)
    .setTitle(`👑 Role: ${role.name}`)
    .addFields(
      { name: '🆔 Role ID',      value: role.id,              inline: true },
      { name: '🎨 Colour',       value: hex,                  inline: true },
      { name: '📅 Created',      value: created,              inline: true },
      { name: '👥 Members',      value: `${members}`,         inline: true },
      { name: '📌 Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
      { name: '📌 Hoisted',     value: role.hoist ? 'Yes' : 'No',       inline: true },
      { name: '🔐 Key permissions', value: perms.slice(0, 1024) },
    )
    .setFooter({ text: '👁️ The Queen sees all.' });

  return i.reply({ embeds: [embed], ephemeral: true });
}

// ─── AFK ──────────────────────────────────────────────────────────────────────
async function handleAfk(i) {
  const message = i.options.getString('message') || 'Away from keyboard.';
  const afk = load('afk.json');
  afk[i.user.id] = { message, since: new Date().toISOString() };
  save('afk.json', afk);
  return i.reply(`👑🪶 You have stepped away…\n\n🖤 *"${message}"*`);
}

async function handleReturn(i) {
  const afk = load('afk.json');
  if (!afk[i.user.id]) return i.reply({ content: '🖤 You were not marked as AFK.', ephemeral: true });
  const since = new Date(afk[i.user.id].since);
  delete afk[i.user.id];
  save('afk.json', afk);
  const mins = Math.round((Date.now() - since) / 60000);
  return i.reply(`👑🪶 Welcome back.\n🖤 *You were away for ${mins} minute(s).*`);
}

// ─── Bless / Curse ────────────────────────────────────────────────────────────
async function handleBless(i) {
  const target = i.options.getUser('user');
  return i.reply(`👑🪶 The Queen favors you…\n\n✨ <@${target.id}> has been bestowed with royal grace. *Do not squander it.*`);
}

async function handleCurse(i) {
  const target = i.options.getUser('user');
  return i.reply(`👑🪶 Do not take this lightly.\n\n🩸 <@${target.id}> — *the shadows now follow you.*`);
}

// ─── Poll ─────────────────────────────────────────────────────────────────────
const POLL_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];

async function handlePoll(i) {
  const sub = i.options.getSubcommand();
  const gid = i.guild.id;
  const polls = load('polls.json');
  if (!polls[gid]) polls[gid] = {};

  if (sub === 'create') {
    const question = i.options.getString('question');
    const options  = [
      i.options.getString('option1'),
      i.options.getString('option2'),
      i.options.getString('option3'),
      i.options.getString('option4'),
      i.options.getString('option5'),
    ].filter(Boolean);

    const lines = options.map((o, idx) => `${POLL_EMOJIS[idx]} ${o}`).join('\n');
    const content = `👑🪶 A decision must be made… 👁️\n\n**${question}**\n\n${lines}`;

    await i.reply({ content: '👁️ Conjuring the poll…', ephemeral: true });
    const msg = await i.channel.send(content);

    for (let idx = 0; idx < options.length; idx++) {
      await msg.react(POLL_EMOJIS[idx]);
    }

    polls[gid].active = msg.id;
    polls[gid][msg.id] = {
      channel_id: i.channel.id,
      question,
      options,
      voters: {},
    };
    save('polls.json', polls);
    await i.editReply({ content: '👑🪶 The poll has been cast. Let them choose.' });
    return;
  }

  const activeId = polls[gid]?.active;
  if (!activeId || !polls[gid][activeId]) {
    return i.reply({ content: '🖤 No active poll found in this server.', ephemeral: true });
  }
  const poll = polls[gid][activeId];
  const channel = i.guild.channels.cache.get(poll.channel_id);

  if (sub === 'results') {
    const counts = poll.options.map((opt, idx) => {
      const votes = Object.values(poll.voters).filter(v => v === idx).length;
      return `${POLL_EMOJIS[idx]} **${opt}** — ${votes} vote(s)`;
    });
    const total = Object.keys(poll.voters).length;
    return i.reply({
      content: `👑🪶 **Current Results**\n\n**${poll.question}**\n\n${counts.join('\n')}\n\n👁️ *${total} vote(s) cast so far.*`,
      ephemeral: true,
    });
  }

  if (sub === 'end') {
    await i.deferReply();
    const counts = poll.options.map((opt, idx) => ({
      opt,
      idx,
      votes: Object.values(poll.voters).filter(v => v === idx).length,
    }));
    const total = Object.keys(poll.voters).length;
    const max   = Math.max(...counts.map(c => c.votes));
    const winners = counts.filter(c => c.votes === max);
    const winnerText = winners.map(w => `${POLL_EMOJIS[w.idx]} **${w.opt}**`).join(' & ');

    const resultLines = counts.map(c => `${POLL_EMOJIS[c.idx]} ${c.opt} — **${c.votes}** vote(s)`).join('\n');
    const tieNote = winners.length > 1 ? '\n\n*It is a tie… the shadows are divided.*' : '';

    await i.editReply(
      `👑🪶 The poll has ended.\n\n**${poll.question}**\n\n${resultLines}\n\n👁️ **Winner:** ${winnerText}${tieNote}\n\n*${total} vote(s) cast.*`
    );

    delete polls[gid].active;
    save('polls.json', polls);
    return;
  }
}

// ─── AFK: auto-detect mentions & returns ─────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const afk = load('afk.json');

  if (afk[message.author.id]) {
    delete afk[message.author.id];
    save('afk.json', afk);
    message.reply('👑🪶 Welcome back.\n🖤 *Your AFK status has been cleared.*').catch(() => {});
  }

  const mentioned = message.mentions.users.filter(u => !u.bot && afk[u.id]);
  for (const [, u] of mentioned) {
    const entry = afk[u.id];
    const since = `<t:${Math.floor(new Date(entry.since) / 1000)}:R>`;
    message.channel.send(`👁️ **${u.tag}** is currently AFK ${since}\n🖤 *"${entry.message}"*`).catch(() => {});
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  if (reaction.message.partial) { try { await reaction.message.fetch(); } catch { return; } }

  const gid = reaction.message.guild?.id;
  if (!gid) return;

  const polls  = load('polls.json');
  const active = polls[gid]?.active;
  if (!active || reaction.message.id !== active) return;

  const poll = polls[gid][active];
  const emojiIdx = POLL_EMOJIS.indexOf(reaction.emoji.name);
  if (emojiIdx === -1) { await reaction.users.remove(user.id).catch(() => {}); return; }

  if (poll.voters[user.id] !== undefined) {
    await reaction.users.remove(user.id).catch(() => {});
    return;
  }

  poll.voters[user.id] = emojiIdx;
  save('polls.json', polls);
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  if (reaction.message.partial) { try { await reaction.message.fetch(); } catch { return; } }

  const gid = reaction.message.guild?.id;
  if (!gid) return;

  const polls  = load('polls.json');
  const active = polls[gid]?.active;
  if (!active || reaction.message.id !== active) return;

  const poll = polls[gid][active];
  if (poll.voters[user.id] !== undefined) {
    delete poll.voters[user.id];
    save('polls.json', polls);
  }
});

// ─── Keep-alive ───────────────────────────────────────────────────────────────
http.createServer((_, res) => {
  res.writeHead(200);
  res.end('👁️ Raven Queen is watching.');
}).listen(PORT, () => console.log(`[Raven Queen] Keep-alive on port ${PORT}`));

// ─── Login ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
