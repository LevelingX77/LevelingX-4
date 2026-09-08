require("dotenv").config();
console.log("[BOOT] Starting application");

const os = require("os");
const express = require("express");

const {
    Client,
    GatewayIntentBits,
    Partials,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ChannelType,
    SlashCommandBuilder,
    REST,
    Routes,
    PermissionsBitField,
    MessageFlags
} = require("discord.js");

// =====================================================
// GLOBAL ERROR HANDLING (ป้องกัน Bot Crash)
// =====================================================
process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
    console.error("❌ Uncaught Exception:", error);
});

// =====================================================
// CONFIG (ENVIRONMENT VARIABLES)
// =====================================================
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const CLIENT_ID = process.env.CLIENT_ID?.trim();
const GUILD_ID = process.env.GUILD_ID?.trim();
const PORT = process.env.PORT || 3000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
    console.error("❌ ขาด Environment Variables ที่จำเป็น (DISCORD_TOKEN, CLIENT_ID, GUILD_ID)");
    process.exit(1);
}
console.log("[BOOT] Environment checked");

// =====================================================
// EXPRESS HTTP SERVER (HEALTH CHECK FOR RENDER)
// =====================================================
const app = express();

app.get("/", (req, res) => {
    res.status(200).json({
        status: "ok",
        bot: client.isReady() ? "online" : "starting",
        uptime: process.uptime()
    });
});

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", message: "Bot is running on Render" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`🌐 HTTP Server listening on port ${PORT}`);
    console.log("[BOOT] HTTP server started");
});

// =====================================================
// IN-MEMORY DATA STORE (ไม่ใช้ Database — ข้อมูลจะหายเมื่อรีสตาร์ทบอท)
// =====================================================
const settingsStore = new Map();      // guild_id -> settings object
const applicationsStore = new Map();  // id -> application object
let nextApplicationId = 1;

const SETTINGS_COLUMNS = [
    "evaluator_role_id", "application_channel_id", "review_channel_id",
    "setup_title", "setup_description", "setup_image", "setup_footer", "setup_color"
];

console.log("[BOOT] In-memory data store initialized (no database)");

// =====================================================
// DATA HELPERS (IN-MEMORY)
// =====================================================
function getSettings(guildId) {
    if (!settingsStore.has(guildId)) {
        const defaults = { guild_id: guildId };
        for (const column of SETTINGS_COLUMNS) defaults[column] = null;
        settingsStore.set(guildId, defaults);
    }
    return settingsStore.get(guildId);
}

function setSetting(guildId, column, value) {
    if (!SETTINGS_COLUMNS.includes(column)) throw new Error("Invalid settings column");
    const settings = getSettings(guildId);
    settings[column] = value;
}

const insertApplication = {
    run(data) {
        const id = nextApplicationId++;
        applicationsStore.set(id, {
            id,
            guild_id: data.guild_id,
            applicant_id: data.applicant_id,
            applicant_tag: data.applicant_tag,
            name_age: data.name_age,
            mbti_position: data.mbti_position,
            work_time: data.work_time,
            experience: data.experience,
            additional_info: data.additional_info || "",
            status: "pending",
            evaluator_id: null,
            evaluator_tag: null,
            reason: null,
            message_id: null,
            channel_id: null,
            created_at: data.created_at,
            evaluated_at: null
        });
        return { lastInsertRowid: id };
    }
};

const getApplication = {
    get(id) {
        return applicationsStore.get(Number(id));
    }
};

const setApplicationMessage = {
    run(messageId, channelId, applicationId) {
        const application = applicationsStore.get(Number(applicationId));
        if (!application) return { changes: 0 };
        application.message_id = messageId;
        application.channel_id = channelId;
        return { changes: 1 };
    }
};

const evaluateApplication = {
    run(status, evaluatorId, evaluatorTag, reason, evaluatedAt, applicationId) {
        const application = applicationsStore.get(Number(applicationId));
        if (!application || application.status !== "pending") return { changes: 0 };
        application.status = status;
        application.evaluator_id = evaluatorId;
        application.evaluator_tag = evaluatorTag;
        application.reason = reason;
        application.evaluated_at = evaluatedAt;
        return { changes: 1 };
    }
};

// =====================================================
// DISCORD CLIENT
// =====================================================
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel]
});

client.on("error", (error) => {
    console.error("[DISCORD] Client error:", error?.message || error);
});

client.on("shardError", (error) => {
    console.error("[DISCORD] Shard error:", error?.message || error);
});

// =====================================================
// COLORS & EMBED HELPERS
// =====================================================
const COLORS = {
    MAIN: 0x5865F2, SUCCESS: 0x57F287, ERROR: 0xED4245, WARNING: 0xFEE75C, WHITE: 0xFFFFFF, DARK: 0x2B2D31
};

function successEmbed(title, description) {
    return new EmbedBuilder().setColor(COLORS.SUCCESS).setTitle(`✅ ${title}`).setDescription(description).setTimestamp();
}

function errorEmbed(title, description) {
    return new EmbedBuilder().setColor(COLORS.ERROR).setTitle(`❌ ${title}`).setDescription(description).setTimestamp();
}

function infoEmbed(title, description) {
    return new EmbedBuilder().setColor(COLORS.MAIN).setTitle(title).setDescription(description).setTimestamp();
}

// =====================================================
// COMPONENT BUILDERS (RECRUITMENT)
// =====================================================
function createRecruitmentEmbed(settings) {
    const embed = new EmbedBuilder().setColor(settings.setup_color || "#5865F2").setTimestamp();
    if (settings.setup_title) embed.setTitle(settings.setup_title);
    if (settings.setup_description) embed.setDescription(settings.setup_description);
    if (settings.setup_image) embed.setImage(settings.setup_image);
    if (settings.setup_footer) embed.setFooter({ text: settings.setup_footer });
    return embed;
}

function createRecruitmentButton() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("recruitment_apply").setLabel(" กดสมัครเป็นทีมงาน").setStyle(ButtonStyle.Success)
    );
}

function createApplicationEmbed(application) {
    let status = "⚪ รอการประเมิน";
    let color = COLORS.WHITE;
    if (application.status === "passed") {
        status = "🟢 ผ่านการคัดเลือก";
        color = COLORS.SUCCESS;
    } else if (application.status === "failed") {
        status = "🔴 ไม่ผ่านการคัดเลือก";
        color = COLORS.ERROR;
    }

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle("มีใบสมัครทีมงาสส่งเข้ามาใหม่")
        .addFields(
            { name: "ผู้สมัคร", value: `<@${application.applicant_id}>\n\`${application.applicant_tag}\``, inline: false },
            { name: "ชื่อ และ อายุ", value: application.name_age || "-", inline: false },
            { name: "ตำแหน่ง", value: application.mbti_position || "-", inline: false },
            { name: "เวลาว่าง", value: application.work_time || "-", inline: false },
            { name: "ประสบการณ์", value: application.experience || "-", inline: false },
            { name: "ข้อมูลเพิ่มเติม", value: application.additional_info || "ไม่มีข้อมูลเพิ่มเติม", inline: false },
            { name: "ผลการประเมิน", value: status, inline: false }
        );

    if (application.evaluator_id) {
        embed.addFields({ name: "ผู้ประเมิน", value: `<@${application.evaluator_id}>`, inline: false });
    }
    if (application.reason) {
        embed.addFields({ name: "เหตุผล", value: application.reason, inline: false });
    }

    embed.setFooter({ text: `Application ID: ${application.id}` });
    embed.setTimestamp(new Date(application.created_at));
    return embed;
}

function createEvaluationButtons(applicationId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`application_pass_${applicationId}`).setLabel("ผ่าน").setEmoji("🟢").setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(`application_fail_${applicationId}`).setLabel("ไม่ผ่าน").setEmoji("🔴").setStyle(ButtonStyle.Danger).setDisabled(disabled)
    );
}

// =====================================================
// MODALS & SELECT MENUS
// =====================================================
function createApplicationModal() {
    const modal = new ModalBuilder().setCustomId("application_modal").setTitle("สมัครทีมงาน");
    const nameAge = new TextInputBuilder().setCustomId("name_age").setLabel("ชื่อ และ อายุ").setPlaceholder("เช่น บีม 17").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
    const mbtiPosition = new TextInputBuilder().setCustomId("mbti_position").setLabel("ตำแหน่งที่สมัคร").setPlaceholder("เช่น INT เป็นต้น").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
    const workTime = new TextInputBuilder().setCustomId("work_time").setLabel("เวลาว่าง").setPlaceholder("เช่น 20:00 - 00:00").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(200);
    const experience = new TextInputBuilder().setCustomId("experience").setLabel("ประสบการณ์").setPlaceholder("เคยทำดิสไหนทาก่อน").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
    const additionalInfo = new TextInputBuilder().setCustomId("additional_info").setLabel("ข้อมูลเพิ่มเติม").setPlaceholder("ข้อมูลอื่น ๆ ที่อยากแจ้ง").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nameAge),
        new ActionRowBuilder().addComponents(mbtiPosition),
        new ActionRowBuilder().addComponents(workTime),
        new ActionRowBuilder().addComponents(experience),
        new ActionRowBuilder().addComponents(additionalInfo)
    );
    return modal;
}

function createEvaluationModal(applicationId, result) {
    const title = result === "passed" ? "🟢 ผ่านการคัดเลือก" : "🔴 ไม่ผ่านการคัดเลือก";
    const modal = new ModalBuilder().setCustomId(`evaluation_modal_${result}_${applicationId}`).setTitle(title);
    const reason = new TextInputBuilder().setCustomId("evaluation_reason").setLabel("เหตุผลประกอบ").setPlaceholder("กรอกเหตุผลในการประเมิน...").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000);
    modal.addComponents(new ActionRowBuilder().addComponents(reason));
    return modal;
}

function createSetupModal() {
    const modal = new ModalBuilder().setCustomId("setup_modal").setTitle("⚙️ ตั้งค่า Embed รับสมัคร");
    const title = new TextInputBuilder().setCustomId("setup_title").setLabel("Title").setPlaceholder("หัวข้อ Embed (ไม่ใส่ก็ได้)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256);
    const description = new TextInputBuilder().setCustomId("setup_description").setLabel("Description").setPlaceholder("รายละเอียด Embed (ไม่ใส่ก็ได้)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000);
    const image = new TextInputBuilder().setCustomId("setup_image").setLabel("Image URL").setPlaceholder("https://... (ไม่ใส่ก็ได้)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(1000);
    const footer = new TextInputBuilder().setCustomId("setup_footer").setLabel("Footer").setPlaceholder("ข้อความด้านล่าง Embed").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2048);
    const color = new TextInputBuilder().setCustomId("setup_color").setLabel("Color").setPlaceholder("#5865F2 หรือ 5865F2").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20);

    modal.addComponents(
        new ActionRowBuilder().addComponents(title),
        new ActionRowBuilder().addComponents(description),
        new ActionRowBuilder().addComponents(image),
        new ActionRowBuilder().addComponents(footer),
        new ActionRowBuilder().addComponents(color)
    );
    return modal;
}

function createSetupChannelSelect() {
    return new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder().setCustomId("setup_send_channel").setPlaceholder("เลือกห้องที่จะส่ง Embed รับสมัคร").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1)
    );
}

function createChannelSettingsComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId("set_application_channel").setPlaceholder("เลือกห้องรับใบสมัคร").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1)
        ),
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId("set_review_channel").setPlaceholder("เลือกห้องสำหรับแอดมินประเมิน").setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1)
        )
    ];
}

function createRoleSelect() {
    return new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder().setCustomId("set_evaluator_role").setPlaceholder("เลือก Role สำหรับผู้ประเมิน").setMinValues(1).setMaxValues(1)
    );
}

// =====================================================
// SYSTEM UTILITIES (PING)
// =====================================================
function getCpuUsage() {
    const start = os.cpus();
    if (!start || start.length === 0) return Promise.resolve(0);
    const startIdle = start.reduce((sum, cpu) => sum + cpu.times.idle, 0);
    const startTotal = start.reduce((sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq, 0);

    return new Promise(resolve => {
        setTimeout(() => {
            const end = os.cpus();
            const endIdle = end.reduce((sum, cpu) => sum + cpu.times.idle, 0);
            const endTotal = end.reduce((sum, cpu) => sum + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq, 0);
            const idle = endIdle - startIdle;
            const total = endTotal - startTotal;
            const usage = total === 0 ? 0 : ((total - idle) / total) * 100;
            resolve(usage);
        }, 500);
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    return ((bytes / Math.pow(1024, index)).toFixed(2) + " " + units[index]);
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    seconds %= 86400;
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds = Math.floor(seconds % 60);
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

// =====================================================
// SLASH COMMANDS
// =====================================================
const commands = [
    new SlashCommandBuilder().setName("set").setDescription("ตั้งค่าระบบบอท")
        .addSubcommand(sub => sub.setName("role").setDescription("ตั้ง Role สำหรับผู้ประเมิน"))
        .addSubcommand(sub => sub.setName("channel").setDescription("ตั้งค่าห้องของระบบสมัคร")),
    new SlashCommandBuilder().setName("setup").setDescription("สร้าง Embed รับสมัครทีมงาน"),
    new SlashCommandBuilder().setName("ping").setDescription("ดู Ping และข้อมูล Host"),
    new SlashCommandBuilder().setName("help").setDescription("ดูวิธีใช้คำสั่งทั้งหมด")
].map(command => command.toJSON());

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    try {
        console.log("⏳ กำลังลงทะเบียน Slash Commands...");
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
        console.log("✅ ลงทะเบียน Slash Commands สำเร็จ");
    } catch (error) {
        console.error("❌ ลงทะเบียน Commands ไม่สำเร็จ:", error);
    }
}

// =====================================================
// EVENTS
// =====================================================
client.once("ready", async () => {
    console.log("====================================");
    console.log(`[DISCORD] Bot is ready as ${client.user.tag}`);
    console.log(`[DISCORD] Bot ID: ${client.user.id}`);
    console.log(`🤖 Bot: ${client.user.tag}`);
    console.log(`🆔 ID: ${client.user.id}`);
    console.log(`💻 Host: ${os.hostname()}`);
    console.log("====================================");
    await registerCommands();
});

client.on("interactionCreate", async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "set") {
                if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ embeds: [errorEmbed("ไม่มีสิทธิ์", "คำสั่งนี้ใช้ได้เฉพาะเจ้าของเซิร์ฟเวอร์หรือผู้ที่มีสิทธิ์ Administrator เท่านั้น")], flags: MessageFlags.Ephemeral });
                }
                const subcommand = interaction.options.getSubcommand();
                if (subcommand === "role") {
                    return interaction.reply({
                        embeds: [infoEmbed("ตั้ง Role ผู้ประเมิน", "เลือก Role ที่สามารถกด **ผ่าน / ไม่ผ่าน** ใบสมัครได้จากเมนูด้านล่าง")],
                        components: [createRoleSelect()], flags: MessageFlags.Ephemeral
                    });
                }
                if (subcommand === "channel") {
                    return interaction.reply({
                        embeds: [infoEmbed("ตั้งค่าห้องระบบสมัคร", "เลือกห้องทั้ง 2 ห้องด้านล่าง\n\n**ห้องรับใบสมัคร** — ใบสมัครจากผู้สมัครจะถูกส่งเข้าห้องนี้\n\n**ห้องสำหรับแอดมินประเมิน** — ห้องที่แอดมินจะเห็นใบสมัครและกดปุ่ม ผ่าน / ไม่ผ่าน")],
                        components: createChannelSettingsComponents(), flags: MessageFlags.Ephemeral
                    });
                }
            }

            if (interaction.commandName === "setup") {
                if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
                    return interaction.reply({ embeds: [errorEmbed("ไม่มีสิทธิ์", "คำสั่งนี้ใช้ได้เฉพาะหัวดิส")], flags: MessageFlags.Ephemeral });
                }
                return interaction.showModal(createSetupModal());
            }

            if (interaction.commandName === "ping") {
                await interaction.deferReply();
                const discordPing = client.ws.ping;
                const cpuUsage = await getCpuUsage();
                const totalMemory = os.totalmem();
                const freeMemory = os.freemem();
                const usedMemory = totalMemory - freeMemory;
                const botMemory = process.memoryUsage();
                const uptime = formatUptime(process.uptime());
                const hostUptime = formatUptime(os.uptime());
                const cpuModel = os.cpus()[0]?.model || "Unknown";
                const cpuCores = os.cpus().length || 0;

                const embed = new EmbedBuilder().setColor(COLORS.MAIN).setTitle(" Bot System Status")
                    .addFields(
                        { name: "Ping", value: `\`${discordPing}ms\``, inline: true },
                        { name: "CPU", value: `${cpuUsage.toFixed(2)}%\n${cpuCores} Cores`, inline: true },
                        { name: "Host RAM", value: `${formatBytes(usedMemory)} / ${formatBytes(totalMemory)}\nFree: ${formatBytes(freeMemory)}`, inline: true },
                        { name: "Bot RAM", value: `RSS: ${formatBytes(botMemory.rss)}\nHeap: ${formatBytes(botMemory.heapUsed)}`, inline: true },
                        { name: "Bot Uptime", value: uptime, inline: true },
                        { name: "Host Uptime", value: hostUptime, inline: true },
                        { name: "CPU Model", value: `\`${cpuModel}\``, inline: false }
                    ).setFooter({ text: `Node.js ${process.version} • ${os.platform()} ${os.arch()}` }).setTimestamp();
                return interaction.editReply({ embeds: [embed] });
            }

            if (interaction.commandName === "help") {
                const embed = new EmbedBuilder().setColor(COLORS.MAIN).setTitle("คำสั่งระบบ").setDescription(
                    "`/setup`\nสร้าง Embed รับสมัครทีมงาน พร้อม Preview และเลือกห้องส่ง\n\n`/set role`\nตั้ง Role ที่สามารถประเมินใบสมัคร\n\n`/set channel`\nตั้งห้องรับใบสมัครและห้องสำหรับแอดมินประเมิน\n\n`/ping`\nแสดง Ping, CPU, RAM, Uptime และข้อมูล Host\n\n`/help`\nแสดงรายการคำสั่งทั้งหมด"
                ).setTimestamp();
                return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
            }
        }

        if (interaction.isButton() && interaction.customId === "recruitment_apply") {
            return interaction.showModal(createApplicationModal());
        }

        if (interaction.isRoleSelectMenu() && interaction.customId === "set_evaluator_role") {
            if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ embeds: [errorEmbed("ไม่มีสิทธิ์", "คุณไม่มีสิทธิ์ตั้งค่า Role")], flags: MessageFlags.Ephemeral });
            }
            const roleId = interaction.values[0];
            const role = interaction.guild.roles.cache.get(roleId);
            if (!role) return interaction.update({ embeds: [errorEmbed("ไม่พบ Role", "ไม่สามารถหา Role ที่เลือกได้")], components: [] });
            setSetting(interaction.guild.id, "evaluator_role_id", role.id);
            return interaction.update({ embeds: [successEmbed("ตั้ง Role สำเร็จ", `Role สำหรับผู้ประเมินคือ ${role}\n\nสมาชิกที่มี Role นี้สามารถกด **ผ่าน / ไม่ผ่าน** ใบสมัครได้`)], components: [] });
        }

        if (interaction.isChannelSelectMenu() && interaction.customId === "set_application_channel") {
            if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ embeds: [errorEmbed("ไม่มีสิทธิ์", "คุณไม่มีสิทธิ์ตั้งค่าห้อง")], flags: MessageFlags.Ephemeral });
            }
            const channelId = interaction.values[0];
            setSetting(interaction.guild.id, "application_channel_id", channelId);
            return interaction.reply({ embeds: [successEmbed("ตั้งห้องรับใบสมัครสำเร็จ", `ใบสมัครจะถูกส่งไปที่ <#${channelId}>`)], flags: MessageFlags.Ephemeral });
        }

        if (interaction.isChannelSelectMenu() && interaction.customId === "set_review_channel") {
            if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ embeds: [errorEmbed("ไม่มีสิทธิ์", "คุณไม่มีสิทธิ์ตั้งค่าห้อง")], flags: MessageFlags.Ephemeral });
            }
            const channelId = interaction.values[0];
            setSetting(interaction.guild.id, "review_channel_id", channelId);
            return interaction.reply({ embeds: [successEmbed("ตั้งห้องประเมินสำเร็จ", `ใบสมัครสำหรับแอดมินจะอยู่ที่ <#${channelId}>`)], flags: MessageFlags.Ephemeral });
        }

        if (interaction.isModalSubmit() && interaction.customId === "setup_modal") {
            const title = interaction.fields.getTextInputValue("setup_title") || "";
            const description = interaction.fields.getTextInputValue("setup_description") || "";
            const image = interaction.fields.getTextInputValue("setup_image") || "";
            const footer = interaction.fields.getTextInputValue("setup_footer") || "";
            let color = interaction.fields.getTextInputValue("setup_color") || "#5865F2";

            if (!/^#?[0-9A-Fa-f]{6}$/.test(color)) {
                return interaction.reply({ embeds: [errorEmbed("สีไม่ถูกต้อง", "กรุณาใช้รูปแบบ เช่น `#5865F2` หรือ `5865F2`")], flags: MessageFlags.Ephemeral });
            }
            if (!color.startsWith("#")) color = "#" + color;
            if (image) {
                try { new URL(image); } catch { return interaction.reply({ embeds: [errorEmbed("Image URL ไม่ถูกต้อง", "กรุณาใส่ URL รูปภาพที่ถูกต้อง")], flags: MessageFlags.Ephemeral }); }
            }

            const previewEmbed = new EmbedBuilder().setColor(color);
            if (title) previewEmbed.setTitle(title);
            if (description) previewEmbed.setDescription(description);
            if (image) previewEmbed.setImage(image);
            if (footer) previewEmbed.setFooter({ text: footer });
            previewEmbed.setTimestamp();

            const token = `${Date.now()}_${interaction.user.id}`;
            global.setupCache = global.setupCache || new Map();
            global.setupCache.set(token, { guildId: interaction.guild.id, userId: interaction.user.id, title, description, image, footer, color });
            setTimeout(() => { global.setupCache?.delete(token); }, 10 * 60 * 1000);

            const confirmButton = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`setup_confirm_${token}`).setLabel("ตกลงและเลือกห้อง").setEmoji("💾").setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`setup_cancel_${token}`).setLabel("ยกเลิก").setEmoji("❌").setStyle(ButtonStyle.Danger)
            );

            return interaction.reply({
                embeds: [infoEmbed("ตัวอย่าง Embed", "ตรวจสอบตัวอย่างด้านล่าง\n\nถ้าพอใจ ให้กด **ตกลงและเลือกห้อง**"), previewEmbed],
                components: [confirmButton], flags: MessageFlags.Ephemeral
            });
        }

        if (interaction.isButton() && interaction.customId.startsWith("setup_confirm_")) {
            const token = interaction.customId.replace("setup_confirm_", "");
            const data = global.setupCache?.get(token);
            if (!data) return interaction.update({ embeds: [errorEmbed("หมดเวลา", "ข้อมูล Setup นี้หมดอายุแล้ว กรุณาใช้ `/setup` ใหม่")], components: [] });
            if (data.userId !== interaction.user.id || data.guildId !== interaction.guild.id) return interaction.reply({ embeds: [errorEmbed("ไม่ใช่ผู้หัวดิส", "เฉพาะคนที่สร้าง Setup นี้เท่านั้นที่สามารถบันทึกได้")], flags: MessageFlags.Ephemeral });
            return interaction.update({ embeds: [infoEmbed("เลือกห้อง", "เลือกห้องที่ต้องการให้บอทส่ง Embed รับสมัครไป")], components: [createSetupChannelSelect()] });
        }

        if (interaction.isButton() && interaction.customId.startsWith("setup_cancel_")) {
            const token = interaction.customId.replace("setup_cancel_", "");
            global.setupCache?.delete(token);
            return interaction.update({ embeds: [infoEmbed("ยกเลิกแล้ว", "ไม่ได้บันทึก Embed นี้")], components: [] });
        }

        if (interaction.isChannelSelectMenu() && interaction.customId === "setup_send_channel") {
            let data = null;
            let token = null;
            for (const [key, value] of (global.setupCache || new Map())) {
                if (value.userId === interaction.user.id && value.guildId === interaction.guild.id) {
                    data = value;
                    token = key;
                }
            }
            if (!data) return interaction.update({ embeds: [errorEmbed("หมดเวลา", "ข้อมูล Setup หมดอายุแล้ว กรุณาใช้ `/setup` ใหม่")], components: [] });

            const channelId = interaction.values[0];
            const channel = interaction.guild.channels.cache.get(channelId);
            if (!channel) return interaction.update({ embeds: [errorEmbed("ไม่พบห้อง", "ไม่สามารถหาห้องที่เลือกได้")], components: [] });

            setSetting(interaction.guild.id, "setup_title", data.title);
            setSetting(interaction.guild.id, "setup_description", data.description);
            setSetting(interaction.guild.id, "setup_image", data.image);
            setSetting(interaction.guild.id, "setup_footer", data.footer);
            setSetting(interaction.guild.id, "setup_color", data.color);

            try {
                const settings = getSettings(interaction.guild.id);
                await channel.send({ embeds: [createRecruitmentEmbed(settings)], components: [createRecruitmentButton()] });
            } catch (error) {
                console.error(error);
                return interaction.update({ embeds: [errorEmbed("ส่ง Embed ไม่สำเร็จ", "บอทไม่มีสิทธิ์ส่งข้อความในห้องที่เลือก หรือเกิดข้อผิดพลาด")], components: [] });
            }

            global.setupCache?.delete(token);
            return interaction.update({ embeds: [successEmbed("Setup สำเร็จ", `ส่ง Embed รับสมัครไปที่ ${channel} เรียบร้อยแล้ว`)], components: [] });
        }

        if (interaction.isModalSubmit() && interaction.customId === "application_modal") {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const settings = getSettings(interaction.guild.id);

            if (!settings.review_channel_id) {
                return interaction.editReply({ embeds: [errorEmbed("ระบบยังไม่พร้อม", "หัวดิสยังไม่ได้ตั้ง **ห้องสำหรับแอดมินประเมิน**\n\nให้หัวดิสใช้ `/set channel` ก่อน")] });
            }

            const applicant = interaction.user;
            const applicationData = {
                guild_id: interaction.guild.id,
                applicant_id: applicant.id,
                applicant_tag: applicant.tag,
                name_age: interaction.fields.getTextInputValue("name_age"),
                mbti_position: interaction.fields.getTextInputValue("mbti_position"),
                work_time: interaction.fields.getTextInputValue("work_time"),
                experience: interaction.fields.getTextInputValue("experience"),
                additional_info: interaction.fields.getTextInputValue("additional_info") || "",
                created_at: Date.now()
            };

            const result = insertApplication.run(applicationData);
            const applicationId = Number(result.lastInsertRowid);
            const application = getApplication.get(applicationId);
            const reviewChannel = interaction.guild.channels.cache.get(settings.review_channel_id);

            if (!reviewChannel) {
                return interaction.editReply({ embeds: [errorEmbed("ไม่พบห้องประเมิน", "กรุณาใช้ `/set channel` ตั้งห้องใหม่")] });
            }

            let message;
            try {
                message = await reviewChannel.send({ embeds: [createApplicationEmbed(application)], components: [createEvaluationButtons(applicationId)] });
            } catch (error) {
                console.error(error);
                return interaction.editReply({ embeds: [errorEmbed("ส่งใบสมัครไม่สำเร็จ", "บอทไม่มีสิทธิ์ส่งข้อความในห้องประเมิน")] });
            }

            setApplicationMessage.run(message.id, reviewChannel.id, applicationId);
            return interaction.editReply({ embeds: [successEmbed("ส่งใบสมัครสำเร็จ", "ใบสมัครของคุณถูกส่งให้ทีมงานตรวจสอบแล้วค่ะ\n\nเมื่อทีมงานประเมินเสร็จ ระบบจะแจ้งผลให้คุณทราบ")] });
        }

        if (interaction.isButton() && (interaction.customId.startsWith("application_pass_") || interaction.customId.startsWith("application_fail_"))) {
            const settings = getSettings(interaction.guild.id);
            if (!settings.evaluator_role_id) return interaction.reply({ embeds: [errorEmbed("ยังไม่ได้ตั้ง Role", "หัวดิสต้องใช้ `/set role` ก่อน")], flags: MessageFlags.Ephemeral });
            if (!interaction.member.roles.cache.has(settings.evaluator_role_id)) return interaction.reply({ embeds: [errorEmbed("ไม่มีสิทธิ์", "คุณไม่มี Role ที่สามารถประเมินใบสมัครได้")], flags: MessageFlags.Ephemeral });

            const parts = interaction.customId.split("_");
            const action = parts[1];
            const applicationId = Number(parts[2]);

            if (!applicationId || Number.isNaN(applicationId)) return interaction.reply({ embeds: [errorEmbed("ข้อมูลไม่ถูกต้อง", "ไม่พบ ID ของใบสมัคร")], flags: MessageFlags.Ephemeral });
            const application = getApplication.get(applicationId);
            if (!application || application.guild_id !== interaction.guild.id) return interaction.reply({ embeds: [errorEmbed("ไม่พบใบสมัคร", "ใบสมัครนี้ไม่มีอยู่ในระบบแล้ว")], flags: MessageFlags.Ephemeral });
            if (application.status !== "pending") return interaction.reply({ embeds: [errorEmbed("ประเมินไปแล้ว", "ใบสมัครนี้ถูกประเมินไปแล้ว ไม่สามารถประเมินซ้ำได้")], flags: MessageFlags.Ephemeral });

            const result = action === "pass" ? "passed" : "failed";
            return interaction.showModal(createEvaluationModal(applicationId, result));
        }

        if (interaction.isModalSubmit() && interaction.customId.startsWith("evaluation_modal_")) {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const parts = interaction.customId.split("_");
            const result = parts[2];
            const applicationId = Number(parts[3]);

            if (!["passed", "failed"].includes(result)) return interaction.editReply({ embeds: [errorEmbed("ข้อมูลผิดพลาด", "ไม่พบผลการประเมินที่ถูกต้อง")] });

            const settings = getSettings(interaction.guild.id);
            if (!settings.evaluator_role_id || !interaction.member.roles.cache.has(settings.evaluator_role_id)) {
                return interaction.editReply({ embeds: [errorEmbed("ไม่มีสิทธิ์", "คุณไม่มี Role สำหรับประเมินใบสมัคร")] });
            }

            const application = getApplication.get(applicationId);
            if (!application || application.guild_id !== interaction.guild.id) return interaction.editReply({ embeds: [errorEmbed("ไม่พบใบสมัคร", "ไม่พบใบสมัครนี้ในฐานข้อมูล")] });
            if (application.status !== "pending") return interaction.editReply({ embeds: [errorEmbed("ประเมินไปแล้ว", "ใบสมัครนี้ถูกประเมินไปแล้ว")] });

            const reason = interaction.fields.getTextInputValue("evaluation_reason");
            const evalResult = evaluateApplication.run(result, interaction.user.id, interaction.user.tag, reason, Date.now(), applicationId);
            if (evalResult.changes === 0) {
                return interaction.editReply({ embeds: [errorEmbed("ประเมินไปแล้ว", "ใบสมัครนี้ถูกประเมินไปแล้ว")] });
            }
            const updatedApplication = getApplication.get(applicationId);
            const channel = client.channels.cache.get(application.channel_id);

            if (channel) {
                try {
                    const message = await channel.messages.fetch(application.message_id);
                    await message.edit({ embeds: [createApplicationEmbed(updatedApplication)], components: [createEvaluationButtons(applicationId, true)] });
                } catch (error) {
                    console.error("Update application message error:", error);
                }
            }

            try {
                const applicant = await client.users.fetch(application.applicant_id);
                const passed = result === "passed";
                const resultEmbed = new EmbedBuilder()
                    .setColor(passed ? COLORS.SUCCESS : COLORS.ERROR)
                    .setTitle("ผลการสมัครทีมงาน")
                    .setDescription(passed ? "**ผ่านการคัดเลือก**" : "**ไม่ผ่านการคัดเลือก**")
                    .addFields(
                        { name: "ผู้ประเมิน", value: `<@${interaction.user.id}>`, inline: false },
                        { name: "เหตุผล", value: reason, inline: false }
                    ).setTimestamp();
                await applicant.send({ embeds: [resultEmbed] });
            } catch {
                console.log(`ไม่สามารถ DM ${application.applicant_id} ได้`);
            }

            return interaction.editReply({
                embeds: [successEmbed("บันทึกผลสำเร็จ", result === "passed" ? "บันทึกผล **ผ่านการคัดเลือก** เรียบร้อยแล้ว" : "บันทึกผล **ไม่ผ่านการคัดเลือก** เรียบร้อยแล้ว")]
            });
        }
    } catch (error) {
        console.error("❌ Interaction Error:", error);
        try {
            if (interaction.deferred) {
                await interaction.editReply({ embeds: [errorEmbed("เกิดข้อผิดพลาด", "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง")] });
            } else if (!interaction.replied) {
                await interaction.reply({ embeds: [errorEmbed("เกิดข้อผิดพลาด", "เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง")], flags: MessageFlags.Ephemeral });
            }
        } catch (replyError) {
            console.error("Reply Error:", replyError);
        }
    }
});

// =====================================================
// GRACEFUL SHUTDOWN (สำหรับ Render)
// =====================================================
function shutdownGracefully(signal) {
    console.log(`\n⚠️ ได้รับสัญญาณ ${signal}. กำลังปิดระบบอย่างปลอดภัย...`);
    
    server.close(() => {
        console.log("✅ ปิด HTTP Server สำเร็จ");
    });

    if (client) {
        client.destroy();
        console.log("✅ Disconnect Discord Client สำเร็จ");
    }

    process.exit(0);
}

process.on("SIGINT", () => shutdownGracefully("SIGINT"));
process.on("SIGTERM", () => shutdownGracefully("SIGTERM"));

// =====================================================
// LOGIN
// =====================================================
console.log("[BOOT] Starting Discord client login...");
client.login(TOKEN)
    .then(() => {
        console.log("[DISCORD] Login successful");
    })
    .catch((error) => {
        console.error("[DISCORD] Login failed:", error?.message || error);
    });
