import pg from "pg";
import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

const DATABASE_URL =
  "postgresql://neondb_owner:npg_RtO3yQ5EbdHz@ep-floral-wave-azgw7se6-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

const USERS = "https://users.roblox.com";
const THUMB = "https://thumbnails.roblox.com";
const FRIENDS = "https://friends.roblox.com";

const db = new pg.Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function loadSettings() {
  await db.connect();
  const { rows } = await db.query(
    "SELECT token, client_id, guild_id FROM discord_settings WHERE id = 1"
  );
  const row = rows[0];
  if (!row || !row.token?.trim()) {
    throw new Error(
      "Tabel discord_settings masih kosong. Isi kolom token (dan client_id) dulu."
    );
  }
  return {
    token: row.token.trim(),
    clientId: (row.client_id || "").trim(),
    guildId: /^\d{17,20}$/.test((row.guild_id || "").trim())
      ? row.guild_id.trim()
      : "",
  };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Roblox API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function lookupUsername(username) {
  const clean = String(username).trim().replace(/^@/, "");
  if (!clean) throw new Error("Username kosong");

  const search = await getJson(
    `${USERS}/v1/users/search?keyword=${encodeURIComponent(clean)}&limit=10`
  );

  let userId = null;
  if (search?.data?.length) {
    const exact = search.data.find(
      (u) => u.name.toLowerCase() === clean.toLowerCase()
    );
    userId = (exact || search.data[0]).id;
  }

  if (!userId) {
    const byName = await fetch(`${USERS}/v1/usernames/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ usernames: [clean], excludeBannedUsers: false }),
    });
    if (byName.ok) {
      const body = await byName.json();
      userId = body.data?.[0]?.id ?? null;
    }
  }

  if (!userId) return null;

  const [user, counts, avatar] = await Promise.all([
    getJson(`${USERS}/v1/users/${userId}`),
    getJson(`${FRIENDS}/v1/users/${userId}/friends/count`),
    getJson(
      `${THUMB}/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`
    ),
  ]);

  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName,
    description: user.description || "",
    created: user.created,
    isBanned: user.isBanned,
    hasVerifiedBadge: user.hasVerifiedBadge,
    friends: counts?.count ?? null,
    avatarUrl: avatar?.data?.[0]?.imageUrl ?? null,
    profileUrl: `https://www.roblox.com/users/${user.id}/profile`,
  };
}

function formatDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString("id-ID", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
  });
}

function buildEmbed(user) {
  const embed = new EmbedBuilder()
    .setColor(user.isBanned ? 0xed4245 : 0x00a2ff)
    .setTitle(`${user.displayName} (@${user.name})`)
    .setURL(user.profileUrl)
    .setDescription(user.description || "*Tidak ada bio*")
    .addFields(
      { name: "User ID", value: String(user.id), inline: true },
      {
        name: "Verified",
        value: user.hasVerifiedBadge ? "Ya" : "Tidak",
        inline: true,
      },
      { name: "Banned", value: user.isBanned ? "Ya" : "Tidak", inline: true },
      {
        name: "Friends",
        value: user.friends == null ? "-" : String(user.friends),
        inline: true,
      },
      { name: "Dibuat", value: formatDate(user.created), inline: true }
    )
    .setFooter({ text: "/kepo · Roblox" })
    .setTimestamp();

  if (user.avatarUrl) embed.setThumbnail(user.avatarUrl);
  return embed;
}

async function replyLookup(username, reply) {
  try {
    const user = await lookupUsername(username);
    if (!user) {
      await reply({ content: `Username **${username}** tidak ditemukan.` });
      return;
    }
    await reply({ embeds: [buildEmbed(user)] });
  } catch (err) {
    console.error(err);
    await reply({ content: `Gagal kepo: ${err.message}` });
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("kepo")
    .setDescription("Kepo profil Roblox dari username")
    .addStringOption((opt) =>
      opt
        .setName("username")
        .setDescription("Username Roblox, contoh: nauraaaa_2002")
        .setRequired(true)
    )
    .toJSON(),
];

async function registerCommands(token, clientId, guildId) {
  if (!clientId) {
    console.warn("client_id kosong — slash /kepo tidak didaftarkan.");
    return;
  }
  const rest = new REST({ version: "10" }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
    console.log("Slash /kepo terdaftar di guild.");
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log("Slash /kepo terdaftar global.");
  }
}

const { token, clientId, guildId } = await loadSettings();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`Login sebagai ${c.user.tag}`);
  c.user.setActivity("/kepo username");
  try {
    await registerCommands(token, clientId, guildId);
  } catch (err) {
    console.error("Gagal register slash command:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "kepo") return;

  const username = interaction.options.getString("username", true);
  await interaction.deferReply();
  await replyLookup(username, (payload) => interaction.editReply(payload));
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const match = message.content.trim().match(/^!kepo\s+(\S+)/i);
  if (!match) return;
  await replyLookup(match[1], (payload) => message.reply(payload));
});

client.login(token);
