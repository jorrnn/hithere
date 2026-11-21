require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const helmet = require("helmet");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const webpush = require("web-push");
const { Server } = require("socket.io");
const { pool, initDb } = require("./db");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Create a PostgreSQL database and configure .env.");
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET is missing. Add it to .env.");
  process.exit(1);
}

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error("VAPID keys are missing from .env.");
  process.exit(1);
}

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "../frontend")));

const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  name: "hithere.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 14
  }
});
app.use(sessionMiddleware);

// Get the public VAPID key
app.get("/api/push/public-key", requireAuth, (req, res) => {
  res.json({
    publicKey: process.env.VAPID_PUBLIC_KEY
  });
});

// Save a browser's push subscription
app.post("/api/push/subscribe", requireAuth, async (req, res) => {
  try {
    const subscription = req.body;

    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys?.p256dh ||
      !subscription.keys?.auth
    ) {
      return res.status(400).json({
        error: "Invalid push subscription."
      });
    }

    await pool.query(
      `INSERT INTO push_subscriptions (user_id, subscription)
       VALUES ($1, $2)
       ON CONFLICT (user_id, (subscription->>'endpoint'))
       DO UPDATE SET subscription = EXCLUDED.subscription`,
      [req.session.userId, JSON.stringify(subscription)]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Push subscription error:", err);
    res.status(500).json({
      error: "Could not save push subscription."
    });
  }
});

io.engine.use(sessionMiddleware);

const onlineUsers = new Map();

async function canShowOnlineStatus(userId) {
  const result = await pool.query(
    `SELECT show_online_status
     FROM user_settings
     WHERE user_id = $1`,
    [userId]
  );

  // If no settings exist, online status is visible by default.
  return result.rows[0]?.show_online_status !== false;
}

const cleanUser = (u) => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  avatarColor: u.avatar_color,
  profilePicture: u.profile_picture || null
});

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please sign in to continue." });
  next();
}

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, displayName, email, password } = req.body;
    const normalizedUsername = String(username || "").trim().toLowerCase();
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const name = String(displayName || "").trim();
    if (!/^[a-z0-9_]{3,24}$/.test(normalizedUsername))
      return res.status(400).json({ error: "Username must be 3–24 characters (letters, numbers or underscore)." });
    if (name.length < 2 || name.length > 60)
      return res.status(400).json({ error: "Display name must be 2–60 characters." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail))
      return res.status(400).json({ error: "Enter a valid email address." });
    if (typeof password !== "string" || password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters." });

    const hash = await bcrypt.hash(password, 12);
    const colors = ["#7868e6", "#e58b65", "#3d9b86", "#d16c91", "#5788c7"];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const result = await pool.query(
      "INSERT INTO users (username, display_name, email, password_hash, avatar_color) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [normalizedUsername, name, normalizedEmail, hash, color]
    );
    req.session.userId = result.rows[0].id;
    res.status(201).json({ user: cleanUser(result.rows[0]) });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "That username or email is already in use." });
    console.error(err);
    res.status(500).json({ error: "Could not create your account." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const login = String(req.body.login || "").trim().toLowerCase();
    const result = await pool.query(
      "SELECT * FROM users WHERE email=$1 OR username=$1 LIMIT 1", [login]
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash)))
      return res.status(401).json({ error: "Incorrect username/email or password." });
    req.session.userId = user.id;
    res.json({ user: cleanUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not sign in." });
  }
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("hithere.sid");
    res.json({ ok: true });
  });
});

app.get("/api/me", async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const result = await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId]);
  res.json({ user: result.rows[0] ? cleanUser(result.rows[0]) : null });
});

// UPDATE PROFILE SETTINGS
app.put("/api/profile", requireAuth, async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const displayName = String(req.body.displayName || "").trim();
    const avatarColor = String(req.body.avatarColor || "").trim();

    const allowedColors = [
      "#7868e6",
      "#e58b65",
      "#3d9b86",
      "#d16c91",
      "#5788c7"
    ];

    if (!/^[a-z0-9_]{3,24}$/.test(username)) {
      return res.status(400).json({
        error: "Username must be 3–24 characters using letters, numbers or underscore."
      });
    }

    if (displayName.length < 2 || displayName.length > 60) {
      return res.status(400).json({
        error: "Display name must be between 2 and 60 characters."
      });
    }

    if (!allowedColors.includes(avatarColor)) {
      return res.status(400).json({
        error: "Please select a valid avatar colour."
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET username = $1, display_name = $2, avatar_color = $3
       WHERE id = $4
       RETURNING id, username, display_name, avatar_color, profile_picture`,
      [username, displayName, avatarColor, req.session.userId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "User account not found." });
    }

    res.json({
      message: "Profile updated successfully.",
      user: cleanUser(result.rows[0])
    });

  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        error: "That username is already taken. Please choose another."
      });
    }

    console.error("Profile update error:", err);
    res.status(500).json({
      error: "Could not update your profile. Please try again."
    });
  }
});

// GET USER SETTINGS
// SAVE PROFILE PICTURE
app.put("/api/profile-picture", requireAuth, async (req, res) => {
  try {
    const { profilePicture } = req.body;

    if (typeof profilePicture !== "string") {
      return res.status(400).json({ error: "No picture was received." });
    }

    if (!/^data:image\/(jpeg|png|webp);base64,/.test(profilePicture)) {
      return res.status(400).json({
        error: "Please upload a JPG, PNG or WebP image."
      });
    }

    if (profilePicture.length > 4500000) {
      return res.status(400).json({
        error: "Picture is too large. Please choose a smaller image."
      });
    }

    const result = await pool.query(
      `UPDATE users
       SET profile_picture = $1
       WHERE id = $2
       RETURNING profile_picture`,
      [profilePicture, req.session.userId]
    );

    res.json({
      message: "Profile picture saved successfully.",
      profilePicture: result.rows[0].profile_picture
    });

  } catch (err) {
    console.error("Profile picture error:", err);
    res.status(500).json({
      error: "Could not save your profile picture."
    });
  }
});

// REMOVE PROFILE PICTURE
app.delete("/api/profile-picture", requireAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE users
       SET profile_picture = NULL
       WHERE id = $1`,
      [req.session.userId]
    );

    res.json({
      message: "Profile picture removed successfully."
    });

  } catch (err) {
    console.error("Remove profile picture error:", err);
    res.status(500).json({
      error: "Could not remove profile picture."
    });
  }
});

app.get("/api/settings", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO user_settings (user_id)
       VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [req.session.userId]
    );

    const settings = await pool.query(
      "SELECT * FROM user_settings WHERE user_id=$1",
      [req.session.userId]
    );

    res.json({ settings: settings.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load settings." });
  }
});

// CHANGE ACCOUNT PASSWORD
app.put("/api/settings/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        error: "Please complete all password fields."
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: "Your new password must contain at least 8 characters."
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        error: "Your new passwords do not match."
      });
    }

    const userResult = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.session.userId]
    );

    if (!userResult.rowCount) {
      return res.status(404).json({
        error: "Account not found."
      });
    }

    const validPassword = await bcrypt.compare(
      currentPassword,
      userResult.rows[0].password_hash
    );

    if (!validPassword) {
      return res.status(400).json({
        error: "Your current password is incorrect."
      });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2",
      [newPasswordHash, req.session.userId]
    );

    res.json({
      message: "Your password has been changed successfully."
    });

  } catch (err) {
    console.error("Password change error:", err);

    res.status(500).json({
      error: "Could not change your password."
    });
  }
});

// SAVE USER SETTINGS
app.put("/api/settings", requireAuth, async (req, res) => {
  try {
    const { theme, wallpaper } = req.body;

    const allowedThemes = ["light", "dark"];
    const allowedWallpapers = ["default", "lavender", "cream", "mint"];

    if (!allowedThemes.includes(theme)) {
      return res.status(400).json({ error: "Invalid theme selected." });
    }

    if (!allowedWallpapers.includes(wallpaper)) {
      return res.status(400).json({ error: "Invalid wallpaper selected." });
    }

    const result = await pool.query(
      `INSERT INTO user_settings (user_id, theme, wallpaper)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id)
       DO UPDATE SET
         theme = EXCLUDED.theme,
         wallpaper = EXCLUDED.wallpaper,
         updated_at = NOW()
       RETURNING *`,
      [req.session.userId, theme, wallpaper]
    );

    res.json({
      message: "Appearance settings saved.",
      settings: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save appearance settings." });
  }
});


// SAVE NOTIFICATION SETTINGS
app.put("/api/settings/notifications", requireAuth, async (req, res) => {
  try {
    const { notificationsEnabled, notificationSound } = req.body;

    if (
      typeof notificationsEnabled !== "boolean" ||
      typeof notificationSound !== "boolean"
    ) {
      return res.status(400).json({
        error: "Invalid notification settings."
      });
    }

    const result = await pool.query(
      `INSERT INTO user_settings (
        user_id,
        notifications_enabled,
        notification_sound
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id)
      DO UPDATE SET
        notifications_enabled = EXCLUDED.notifications_enabled,
        notification_sound = EXCLUDED.notification_sound,
        updated_at = NOW()
      RETURNING *`,
      [
        req.session.userId,
        notificationsEnabled,
        notificationSound
      ]
    );

    res.json({
      message: "Notification settings saved.",
      settings: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Could not save notification settings."
    });
  }
});


// SAVE PRIVACY SETTINGS
app.put("/api/settings/privacy", requireAuth, async (req, res) => {
  try {
    const { showOnlineStatus } = req.body;

    if (typeof showOnlineStatus !== "boolean") {
      return res.status(400).json({
        error: "Invalid privacy setting."
      });
    }

    const result = await pool.query(
      `INSERT INTO user_settings (user_id, show_online_status)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET
         show_online_status = EXCLUDED.show_online_status,
         updated_at = NOW()
       RETURNING *`,
      [req.session.userId, showOnlineStatus]
    );

    const userId = req.session.userId;

io.emit("presence:update", {
  userId,
  online: showOnlineStatus && (onlineUsers.get(userId) || 0) > 0
});

res.json({
  message: "Privacy settings saved.",
  settings: result.rows[0]
});

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Could not save privacy settings."
    });
  }
});


app.get("/api/users/search", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 2) return res.json({ users: [] });
  const result = await pool.query(
    `SELECT id, username, display_name, avatar_color, profile_picture FROM users
     WHERE id <> $1 AND (username ILIKE $2 OR display_name ILIKE $2)
     ORDER BY display_name LIMIT 12`,
    [req.session.userId, `%${q}%`]
  );
  res.json({ users: result.rows.map(cleanUser) });
});



app.get("/api/conversations", requireAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT c.id, c.is_group, c.title,

      (
        SELECT json_build_object(
          'id', u.id,
          'username', u.username,
          'displayName', u.display_name,
          'avatarColor', u.avatar_color,
          'profilePicture', u.profile_picture
        )
        FROM conversation_members cm2
        JOIN users u ON u.id = cm2.user_id
        WHERE cm2.conversation_id = c.id
          AND cm2.user_id <> $1
        LIMIT 1
      ) AS other_user,

      (SELECT m.body
       FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC
       LIMIT 1) AS last_message,

      (SELECT m.created_at
       FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC
       LIMIT 1) AS last_message_at,

      (SELECT COUNT(*)
       FROM messages m
       JOIN message_receipts mr ON mr.message_id = m.id
       WHERE m.conversation_id = c.id
         AND mr.user_id = $1
         AND m.sender_id <> $1
         AND mr.read_at IS NULL
      ) AS unread_count

    FROM conversations c
    JOIN conversation_members mine
      ON mine.conversation_id = c.id
     AND mine.user_id = $1

    ORDER BY COALESCE(
      (SELECT MAX(created_at)
       FROM messages
       WHERE conversation_id = c.id),
      c.created_at
    ) DESC
  `, [req.session.userId]);

  res.json({ conversations: result.rows });
});

// GET CALL HISTORY
app.get("/api/calls", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;

    const result = await pool.query(`
      SELECT
        ch.id,
        ch.conversation_id,
        ch.caller_id,
        ch.receiver_id,
        ch.call_type,
        ch.status,
        ch.duration_seconds,
        ch.started_at,
        ch.ended_at,

        caller.username AS caller_username,
        caller.display_name AS caller_name,
        caller.avatar_color AS caller_avatar,

        receiver.username AS receiver_username,
        receiver.display_name AS receiver_name,
        receiver.avatar_color AS receiver_avatar

      FROM call_history ch
      LEFT JOIN users caller ON caller.id = ch.caller_id
      LEFT JOIN users receiver ON receiver.id = ch.receiver_id

      WHERE ch.caller_id = $1 OR ch.receiver_id = $1

      ORDER BY ch.started_at DESC
      LIMIT 100
    `, [userId]);

    res.json({ calls: result.rows });

  } catch (error) {
    console.error("Call history error:", error);
    res.status(500).json({ error: "Could not load call history." });
  }
});

app.post("/api/conversations", requireAuth, async (req, res) => {
  const otherId = Number(req.body.userId);
  if (!Number.isInteger(otherId) || otherId === req.session.userId)
    return res.status(400).json({ error: "Choose another user." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query("SELECT id FROM users WHERE id=$1", [otherId]);
    if (!exists.rowCount) throw new Error("That user does not exist.");
    const existing = await client.query(`
      SELECT c.id FROM conversations c
      JOIN conversation_members a ON a.conversation_id=c.id AND a.user_id=$1
      JOIN conversation_members b ON b.conversation_id=c.id AND b.user_id=$2
      WHERE c.is_group=FALSE
        AND (SELECT COUNT(*) FROM conversation_members x WHERE x.conversation_id=c.id)=2
      LIMIT 1
    `, [req.session.userId, otherId]);
    let conversationId;
    if (existing.rowCount) conversationId = existing.rows[0].id;
    else {
      const created = await client.query(
        "INSERT INTO conversations (created_by) VALUES ($1) RETURNING id", [req.session.userId]
      );
      conversationId = created.rows[0].id;
      await client.query(
        "INSERT INTO conversation_members (conversation_id,user_id) VALUES ($1,$2),($1,$3)",
        [conversationId, req.session.userId, otherId]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ conversationId });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message || "Could not start conversation." });
  } finally { client.release(); }
});

app.get("/api/conversations/:id/messages", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const member = await pool.query(
    "SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2",
    [id, req.session.userId]
  );
  if (!member.rowCount) return res.status(404).json({ error: "Conversation not found." });
  
const result = await pool.query(`
  SELECT
    m.id,
    m.conversation_id,
    m.body,
    m.created_at,
    m.sender_id,
    m.reply_to_id,
    m.deleted_for_everyone,
    u.display_name AS sender_name,
    u.username AS sender_username,

    rm.body AS reply_body,
    ru.display_name AS reply_sender_name,

    COALESCE(r.recipient_count, 0)::int AS recipient_count,
    COALESCE(r.delivered_count, 0)::int AS delivered_count,
    COALESCE(r.read_count, 0)::int AS read_count,

    EXISTS (
      SELECT 1
      FROM message_deletions md
      WHERE md.message_id = m.id
      AND md.user_id = $2
    ) AS deleted_for_me

  FROM messages m
  JOIN users u ON u.id = m.sender_id

  LEFT JOIN messages rm ON rm.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = rm.sender_id

  LEFT JOIN LATERAL (
    SELECT
      COUNT(*) AS recipient_count,
      COUNT(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered_count,
      COUNT(*) FILTER (WHERE read_at IS NOT NULL) AS read_count
    FROM message_receipts
    WHERE message_id = m.id
  ) r ON TRUE

  WHERE m.conversation_id = $1
  AND NOT EXISTS (
    SELECT 1
    FROM message_deletions md
    WHERE md.message_id = m.id
    AND md.user_id = $2
  )

  ORDER BY m.created_at ASC
  LIMIT 2000
`, [id, req.session.userId]);

  res.json({ messages: result.rows });
});

io.use((socket, next) => {
  const userId = socket.request.session?.userId;
  if (!userId) return next(new Error("Sign in required"));
  socket.userId = userId;
  next();
});

io.on("connection", async (socket) => {
  const userId = socket.userId;
  const existingConnections = onlineUsers.get(userId) || 0;

  onlineUsers.set(userId, existingConnections + 1);
  socket.join(`user:${userId}`);

  if (existingConnections === 0) {
  const visible = await canShowOnlineStatus(userId);

  io.emit("presence:update", {
    userId,
    online: visible
  });
}

const presenceList = [];

for (const onlineUserId of onlineUsers.keys()) {
  const visible = await canShowOnlineStatus(onlineUserId);

  if (visible) {
    presenceList.push(Number(onlineUserId));
  }
}

socket.emit("presence:list", presenceList);

  socket.on("conversation:join", async (conversationId) => {
    const id = Number(conversationId);
    if (!Number.isInteger(id)) return;
    const member = await pool.query(
      "SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2",
      [id, userId]
    );
    if (member.rowCount) socket.join(`conversation:${id}`);
  });

  socket.on("message:send", async (payload, callback) => {
  try {
    const conversationId = Number(payload?.conversationId);
    const body = String(payload?.body || "").trim();
    const replyToId = payload?.replyToId ? Number(payload.replyToId) : null;

    if (!Number.isInteger(conversationId) || !body || body.length > 4000)
      throw new Error("Messages must contain 1–4,000 characters.");

    if (replyToId !== null) {
  if (!Number.isInteger(replyToId) || replyToId <= 0) {
    throw new Error("Invalid reply message.");
  }

  const originalMessage = await pool.query(
    "SELECT id FROM messages WHERE id=$1 AND conversation_id=$2",
    [replyToId, conversationId]
  );

  if (!originalMessage.rowCount) {
    throw new Error("The message you are replying to was not found.");
  }
}

    const member = await pool.query(
      "SELECT 1 FROM conversation_members WHERE conversation_id=$1 AND user_id=$2",
      [conversationId, userId]
    );

    if (!member.rowCount)
      throw new Error("You are not a member of this conversation.");

    const result = await pool.query(`
  INSERT INTO messages (conversation_id, sender_id, body, reply_to_id)
  VALUES ($1, $2, $3, $4)
  RETURNING id, conversation_id, sender_id, body, created_at, reply_to_id
`, [conversationId, userId, body, replyToId]);

    const message = result.rows[0];

    const sender = await pool.query(
      "SELECT display_name, username FROM users WHERE id=$1",
      [userId]
    );

    message.sender_name = sender.rows[0].display_name;
    message.sender_username = sender.rows[0].username;

    if (message.reply_to_id) {
  const original = await pool.query(`
    SELECT m.body, u.display_name AS sender_name
    FROM messages m
    JOIN users u ON u.id = m.sender_id
    WHERE m.id = $1
  `, [message.reply_to_id]);

  if (original.rowCount) {
    message.reply_body = original.rows[0].body;
    message.reply_sender_name = original.rows[0].sender_name;
  }
}

    const members = await pool.query(
      `SELECT user_id
       FROM conversation_members
       WHERE conversation_id=$1 AND user_id<>$2`,
      [conversationId, userId]
    );

    await pool.query(`
      INSERT INTO message_receipts (message_id, user_id)
      SELECT $1, user_id
      FROM conversation_members
      WHERE conversation_id=$2 AND user_id<>$3
      ON CONFLICT (message_id, user_id) DO NOTHING
    `, [message.id, conversationId, userId]);

    io.to(`conversation:${conversationId}`).emit("message:new", message);


// Send background push notifications to other conversation members
try {
  const recipientIds = members.rows.map(member => member.user_id);

  if (recipientIds.length > 0) {
    const subscriptions = await pool.query(
      `SELECT id, user_id, subscription
       FROM push_subscriptions
       WHERE user_id = ANY($1::int[])`,
      [recipientIds]
    );

    const payload = JSON.stringify({
      title: message.sender_name || "New message",
      body: message.body || "You received a new message.",
      url: "/"
    });

    await Promise.allSettled(
      subscriptions.rows.map(async (row) => {
        try {
          await webpush.sendNotification(
            row.subscription,
            payload
          );
        } catch (error) {
          if (error.statusCode === 404 || error.statusCode === 410) {
            await pool.query(
              "DELETE FROM push_subscriptions WHERE id = $1",
              [row.id]
            );
          } else {
            console.error("Push notification error:", error.message);
          }
        }
      })
    );
  }
} catch (error) {
  console.error("Background notification error:", error.message);
}


    for (const m of members.rows) {
      io.to(`user:${m.user_id}`).emit("conversation:updated", {
        conversationId
      });
    }

    if (callback) callback({ ok: true, message });

  } catch (err) {
    if (callback) callback({ ok: false, error: err.message });
  }
});

  // DELETE MESSAGE
  socket.on("message:delete", async (payload, callback) => {
    try {
      const messageId = Number(payload?.messageId);
      const deleteType = payload?.deleteType;

      if (!Number.isInteger(messageId) || messageId <= 0) {
        throw new Error("Invalid message.");
      }

      if (!["me", "everyone"].includes(deleteType)) {
        throw new Error("Invalid deletion option.");
      }

      const result = await pool.query(`
        SELECT id, conversation_id, sender_id
        FROM messages
        WHERE id = $1
      `, [messageId]);

      if (!result.rowCount) {
        throw new Error("Message not found.");
      }

      const message = result.rows[0];

      const member = await pool.query(
        `SELECT 1 FROM conversation_members
         WHERE conversation_id = $1 AND user_id = $2`,
        [message.conversation_id, userId]
      );

      if (!member.rowCount) {
        throw new Error("You cannot delete this message.");
      }

      if (deleteType === "everyone") {
        if (Number(message.sender_id) !== Number(userId)) {
          throw new Error("You can only delete your own messages for everyone.");
        }

        await pool.query(`
          UPDATE messages
          SET deleted_for_everyone = TRUE,
              body = 'This message was deleted'
          WHERE id = $1
        `, [messageId]);

        io.to(`conversation:${message.conversation_id}`).emit(
          "message:deleted",
          {
            messageId,
            deleteType: "everyone",
            body: "This message was deleted"
          }
        );

      } else {
        await pool.query(`
          INSERT INTO message_deletions (message_id, user_id)
          VALUES ($1, $2)
          ON CONFLICT (message_id, user_id) DO NOTHING
        `, [messageId, userId]);

        socket.emit("message:deleted", {
          messageId,
          deleteType: "me"
        });
      }

      if (callback) callback({ ok: true });

    } catch (err) {
      if (callback) callback({ ok: false, error: err.message });
    }
  });

  socket.on("message:delivered", async (payload) => {
  try {
    const messageId = Number(payload?.messageId);

    if (!Number.isInteger(messageId) || messageId <= 0) return;

    const result = await pool.query(`
      UPDATE message_receipts mr
      SET delivered_at = COALESCE(mr.delivered_at, NOW())
      FROM messages m
      WHERE mr.message_id = m.id
        AND mr.message_id = $1
        AND mr.user_id = $2
        AND m.sender_id <> $2
      RETURNING mr.message_id, mr.user_id,
                mr.delivered_at, m.sender_id
    `, [messageId, userId]);

    if (!result.rowCount) return;

    const receipt = result.rows[0];

    io.to(`user:${receipt.sender_id}`).emit(
      "message:receipt:update",
      {
        messageId: receipt.message_id,
        userId: receipt.user_id,
        status: "delivered",
        deliveredAt: receipt.delivered_at
      }
    );

  } catch (err) {
    console.error("Delivery receipt error:", err);
  }
});

  socket.on("message:read", async (payload) => {
  try {
    const messageId = Number(payload?.messageId);

    if (!Number.isInteger(messageId) || messageId <= 0) return;

    const result = await pool.query(`
      UPDATE message_receipts mr
      SET read_at = COALESCE(mr.read_at, NOW()),
          delivered_at = COALESCE(mr.delivered_at, NOW())
      FROM messages m
      WHERE mr.message_id = m.id
        AND mr.message_id = $1
        AND mr.user_id = $2
        AND m.sender_id <> $2
      RETURNING mr.message_id, mr.user_id,
                mr.read_at, m.sender_id
    `, [messageId, userId]);

    if (!result.rowCount) return;

    const receipt = result.rows[0];

    io.to(`user:${receipt.sender_id}`).emit(
      "message:receipt:update",
      {
        messageId: receipt.message_id,
        userId: receipt.user_id,
        status: "read",
        readAt: receipt.read_at
      }
    );

  } catch (err) {
    console.error("Read receipt error:", err);
  }
});

  socket.on("disconnect", () => {
    const count = (onlineUsers.get(userId) || 1) - 1;
    if (count <= 0) {
      onlineUsers.delete(userId);
      io.emit("presence:update", { userId, online: false });
    } else onlineUsers.set(userId, count);
  });


// VOICE AND VIDEO CALL SIGNALING

socket.on("call:initiate", async ({ conversationId, offer, callType }) => {
  try {
    const id = Number(conversationId);

    if (!id || !offer) return;

    const members = await pool.query(
      `SELECT user_id FROM conversation_members
       WHERE conversation_id = $1`,
      [id]
    );

    if (!members.rows.some(m => Number(m.user_id) === Number(userId))) return;

    const recipients = members.rows.filter(
      m => Number(m.user_id) !== Number(userId)
    );

    const validCallType = callType === "video" ? "video" : "voice";

    for (const member of recipients) {
      const receiverId = Number(member.user_id);

      const record = await pool.query(`
        INSERT INTO call_history (
          conversation_id,
          caller_id,
          receiver_id,
          call_type,
          status
        )
        VALUES ($1, $2, $3, $4, 'missed')
        RETURNING id
      `, [id, userId, receiverId, validCallType]);

      io.to(`user:${receiverId}`).emit("call:incoming", {
        conversationId: id,
        callerId: userId,
        offer,
        callType: validCallType,
        callHistoryId: record.rows[0].id
      });
    }

  } catch (error) {
    console.error("Call initiation error:", error);
  }
});

// ACCEPT AN INCOMING CALL
socket.on("call:accept", async ({ conversationId, callerId, callHistoryId }) => {
  try {
    const id = Number(conversationId);
    const caller = Number(callerId);
    const historyId = Number(callHistoryId);

    if (!id || !caller || !historyId) return;

    const result = await pool.query(`
      UPDATE call_history
      SET status = 'completed',
          started_at = NOW()
      WHERE id = $1
        AND conversation_id = $2
        AND caller_id = $3
        AND receiver_id = $4
      RETURNING id
    `, [historyId, id, caller, userId]);

    if (!result.rowCount) return;

    io.to(`user:${caller}`).emit("call:accepted", {
      conversationId: id,
      receiverId: userId,
      callHistoryId: historyId
    });

  } catch (error) {
    console.error("Call acceptance error:", error);
  }
});

socket.on("call:signal", async ({ conversationId, targetUserId, signal }) => {
  try {
    const id = Number(conversationId);
    const target = Number(targetUserId);

    if (!id || !target || !signal) return;

    const members = await pool.query(
      `SELECT user_id FROM conversation_members
       WHERE conversation_id = $1`,
      [id]
    );

    const allowed = members.rows.some(m => Number(m.user_id) === Number(userId)) &&
      members.rows.some(m => Number(m.user_id) === target);

    if (!allowed) return;

    io.to(`user:${target}`).emit("call:signal", {
      conversationId: id,
      userId,
      signal
    });
  } catch (error) {
    console.error("Call signal error:", error);
  }
});

// REJECT AN INCOMING CALL
socket.on("call:reject", async ({ conversationId, callerId }) => {
  try {
    const id = Number(conversationId);
    const caller = Number(callerId);

    if (!id || !caller) return;

    const members = await pool.query(
      `SELECT user_id FROM conversation_members
       WHERE conversation_id = $1`,
      [id]
    );

    const allowed =
      members.rows.some(m => Number(m.user_id) === Number(userId)) &&
      members.rows.some(m => Number(m.user_id) === caller);

    if (!allowed) return;

    await pool.query(`
      UPDATE call_history
      SET status = 'rejected',
          ended_at = NOW()
      WHERE id = (
        SELECT id
        FROM call_history
        WHERE conversation_id = $1
          AND caller_id = $2
          AND receiver_id = $3
          AND status = 'missed'
          AND ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1
      )
    `, [id, caller, userId]);

    io.to(`user:${caller}`).emit("call:rejected", {
      conversationId: id,
      userId
    });

  } catch (error) {
    console.error("Call rejection error:", error);
  }
});

socket.on("call:end", ({ conversationId, targetUserId }) => {
  if (!targetUserId) return;

  io.to(`user:${Number(targetUserId)}`).emit("call:ended", {
    conversationId,
    userId
  });
});

// Accept an incoming call
socket.on("call:accept", ({ conversationId, answer }) => {
  const userId = socket.request.session.userId;
  if (!userId) return;

  socket.to(`conversation:${conversationId}`).emit("call:accepted", {
    conversationId,
    userId,
    answer
  });
});

// REJECT AN INCOMING CALL
socket.on("call:reject", async ({ conversationId, callerId }) => {
  try {
    const id = Number(conversationId);
    const caller = Number(callerId);

    if (!id || !caller) return;

    const members = await pool.query(
      `SELECT user_id FROM conversation_members
       WHERE conversation_id = $1`,
      [id]
    );

    const allowed =
      members.rows.some(m => Number(m.user_id) === Number(userId)) &&
      members.rows.some(m => Number(m.user_id) === caller);

    if (!allowed) return;

    io.to(`user:${caller}`).emit("call:rejected", {
      conversationId: id,
      userId
    });
  } catch (error) {
    console.error("Call rejection error:", error);
  }
});


// END AN ACTIVE CALL
// END AN ACTIVE CALL AND SAVE ITS DURATION
socket.on("call:end", async ({ conversationId, targetUserId }) => {
  try {
    const id = Number(conversationId);
    const target = Number(targetUserId);

    if (!id || !target) return;

    const members = await pool.query(
      `SELECT user_id FROM conversation_members
       WHERE conversation_id = $1`,
      [id]
    );

    const allowed =
      members.rows.some(m => Number(m.user_id) === Number(userId)) &&
      members.rows.some(m => Number(m.user_id) === target);

    if (!allowed) return;

    await pool.query(`
      UPDATE call_history
      SET ended_at = NOW(),
          duration_seconds = GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)))::INTEGER
          )
      WHERE conversation_id = $1
        AND (
          (caller_id = $2 AND receiver_id = $3)
          OR
          (caller_id = $3 AND receiver_id = $2)
        )
        AND status = 'completed'
        AND ended_at IS NULL
    `, [id, userId, target]);

    io.to(`user:${target}`).emit("call:ended", {
      conversationId: id,
      userId
    });

  } catch (error) {
    console.error("Call ending error:", error);
  }
});

});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../frontend/index.html")));

initDb().then(() => {
  server.listen(PORT, () => console.log(`HiThere is running at http://localhost:${PORT}`));
}).catch(err => {
  console.error("Database startup failed:", err);
  process.exit(1);
});
