const $ = (selector) => document.querySelector(selector);
const state = {
  user: null,
  mode: "login",
  conversations: [],
  activeId: null,
  activeUser: null,
  socket: null,
  online: new Set(),
  replyingTo: null,

  peer: null,
  localStream: null,
  remoteStream: null,
  callType: null,
  callActive: false,
  incomingCall: null,
  callTimer: null,
  callTargetId: null
};const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const initials = (name) => String(name || "?").trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase();
// START CALL DURATION TIMER
function startCallTimer() {
  if (state.callTimer) {
    clearInterval(state.callTimer);
  }

  let seconds = 0;

  $("#callTimer").textContent = "00:00";

  state.callTimer = setInterval(() => {
    seconds++;

    const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
    const remainingSeconds = String(seconds % 60).padStart(2, "0");

    $("#callTimer").textContent = `${minutes}:${remainingSeconds}`;
  }, 1000);
}
// ========================================
// HITHERE VOICE AND VIDEO CALL FUNCTIONS
// ========================================

async function startCall(callType) {
  try {
    if (!state.socket || !state.activeId || !state.activeUser?.id) {
      toast("Open a one-to-one conversation first.");
      return;
    }

    if (state.peer || state.callActive) {
      toast("You are already in a call.");
      return;
    }

    if (!window.SimplePeer) {
      toast("Calling library could not load.");
      return;
    }

    state.callType = callType;
    state.callTargetId = Number(state.activeUser.id);

    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === "video"
    });

    $("#callModal").classList.remove("hidden");
    $("#callModal").classList.toggle("voice-call", callType === "voice");
    $("#callStatus").textContent = "Calling...";
    $("#callUserName").textContent =
      state.activeUser.displayName || "HiThere user";
    $("#callAvatar").textContent =
      initials(state.activeUser.displayName);

    $("#localVideo").srcObject = state.localStream;

    const peer = new SimplePeer({
      initiator: true,
      trickle: false,
      stream: state.localStream
    });

    state.peer = peer;

    peer.on("signal", offer => {
      state.socket.emit("call:initiate", {
        conversationId: state.activeId,
        offer,
        callType
      });
    });

    peer.on("stream", stream => {
      state.remoteStream = stream;
      $("#remoteVideo").srcObject = stream;
      $("#callStatus").textContent = "Connected";
      startCallTimer();
      state.callActive = true;
    });

    peer.on("error", error => {
      console.error("Outgoing call error:", error);
      toast("Call connection failed.");
      endCall();
    });

  } catch (error) {
    console.error("Could not start call:", error);
    toast("Could not access your microphone or camera.");
    endCall();
  }
}


// End an active call
function endCall(notifyPeer = true) {
  const conversationId =
    state.incomingCall?.conversationId || state.activeId;

  if (notifyPeer && state.socket && state.callTargetId) {
    state.socket.emit("call:end", {
      conversationId,
      targetUserId: state.callTargetId
    });
  }

  if (state.callTimer) {
    clearInterval(state.callTimer);
    state.callTimer = null;
  }

  if (state.peer) {
    state.peer.destroy();
    state.peer = null;
  }

  if (state.localStream) {
    state.localStream.getTracks().forEach(track => track.stop());
    state.localStream = null;
  }

  $("#remoteVideo").srcObject = null;
  $("#localVideo").srcObject = null;

  state.remoteStream = null;
  state.callActive = false;
  state.callType = null;
  state.incomingCall = null;
  state.callTargetId = null;

  $("#callModal").classList.add("hidden");
  $("#callStatus").textContent = "Calling...";
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials:"same-origin", headers:{ "Content-Type":"application/json", ...(options.headers||{}) }, ...options });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}
let toastTimer;
function toast(message) { const el=$("#toast"); el.textContent=message; el.classList.add("show"); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove("show"),2600); }
function showAuth(mode="login") {
  state.mode=mode;
  $("#authView").classList.remove("hidden"); $("#appView").classList.add("hidden");
  const signup=mode==="register";
  $("#authEyebrow").textContent=signup?"YOUR NEXT CHAPTER":"WELCOME BACK";
  $("#authTitle").textContent=signup?"Create your account":"Sign in";
  $("#authSubtitle").textContent=signup?"A little space for the people who matter.":"Pick up right where you left off.";
  $("#nameField").classList.toggle("hidden",!signup);
  $("#usernameField").classList.toggle("hidden",!signup);
  $("#emailLabel").textContent=signup?"Email address":"Email or username";
  $("#loginEmail").placeholder=signup?"you@example.com":"you@example.com";
  $("#authSubmit").innerHTML=signup?'Create account <span>→</span>':'Sign in <span>→</span>';
  $("#switchText").innerHTML=signup?'Already have an account? <button id="switchAuth" type="button">Sign in</button>':'New to HiThere? <button id="switchAuth" type="button">Create an account</button>';
  $("#switchAuth").addEventListener("click",()=>showAuth(signup?"login":"register"));
  $("#authError").textContent="";
}
$("#authForm").addEventListener("submit", async (event)=>{
  event.preventDefault(); $("#authError").textContent="";
  const signup=state.mode==="register";
  const body=signup?{
    displayName:$("#displayName").value, username:$("#username").value,
    email:$("#loginEmail").value, password:$("#password").value
  }:{ login:$("#loginEmail").value, password:$("#password").value };
  try {
    const result=await api(`/api/auth/${signup?"register":"login"}`,{method:"POST",body:JSON.stringify(body)});
    await enterApp(result.user);
  } catch(err) { $("#authError").textContent=err.message; }
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const rawData = window.atob(base64);
  return Uint8Array.from(
    [...rawData].map(char => char.charCodeAt(0))
  );
}

async function enableNotifications() {
  try {
    if (!("Notification" in window) ||
        !("serviceWorker" in navigator) ||
        !("PushManager" in window)) {
      alert("Push notifications are not supported by this browser.");
      return;
    }

    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      alert("Please allow notifications in your browser settings.");
      return;
    }

    const registration = await navigator.serviceWorker.register(
      "/service-worker.js"
    );

    await navigator.serviceWorker.ready;

    const keyResponse = await fetch("/api/push/public-key");

    if (!keyResponse.ok) {
      throw new Error("Could not retrieve notification settings. Please log in again.");
    }

    const { publicKey } = await keyResponse.json();

    const subscription =
      await registration.pushManager.getSubscription() ||
      await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });

    const saveResponse = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(subscription)
    });

    if (!saveResponse.ok) {
      throw new Error("Could not save your notification subscription.");
    }

    alert("Background notifications enabled successfully!");
  } catch (error) {
    console.error("Notification setup error:", error);
    alert(error.message || "Could not enable notifications.");
  }
}


const notificationBtn = $("#enableNotificationsBtn");

if (notificationBtn) {
  notificationBtn.addEventListener("click", enableNotifications);
}


async function enterApp(user) {
  state.user = user;

  $("#authView").classList.add("hidden");
  $("#appView").classList.remove("hidden");

  $("#myName").textContent = user.displayName;
  $("#myHandle").textContent = "@" + user.username;
  $("#myAvatar").textContent = initials(user.displayName);
  $("#myAvatar").style.background = user.avatarColor;

  state.socket = io();

  state.socket.on("presence:list", userIds => {
    state.online = new Set(userIds.map(Number));
    renderConversations();
    renderOnlinePeople();

    if (state.activeUser) {
      renderActiveHeader();
      renderDetails();
    }
  });

  state.socket.on("connect_error", () => {
    toast("Live connection interrupted. Refresh if messages stop updating.");
  });

  // Handle call connection signals
state.socket.on("call:signal", data => {
  if (
    !state.peer ||
    Number(data.conversationId) !== Number(state.activeId) &&
    Number(data.conversationId) !== Number(state.incomingCall?.conversationId)
  ) {
    return;
  }

  try {
    state.peer.signal(data.signal);
  } catch (error) {
    console.error("Call signal error:", error);
  }
});

// Handle rejected calls
state.socket.on("call:rejected", () => {
  toast("The other person declined your call.");
  endCall(false);
});

// Handle calls ended by the other person
state.socket.on("call:ended", () => {
  toast("The other person ended the call.");
  endCall(false);
});

  // Handle incoming calls
state.socket.on("call:incoming", async (data) => {
  if (state.callActive || state.incomingCall) {
    state.socket.emit("call:reject", {
      conversationId: data.conversationId,
      callerId: data.callerId
    });
    return;
  }

  state.incomingCall = data;
  state.callTargetId = Number(data.callerId);

  const conversation = state.conversations.find(
    c => Number(c.id) === Number(data.conversationId)
  );

  const callerName =
    conversation?.other_user?.displayName || "HiThere user";

  const accepted = confirm(
    `${callerName} is calling you (${data.callType}). Accept?`
  );

  if (!accepted) {
    state.socket.emit("call:reject", {
      conversationId: data.conversationId,
      callerId: data.callerId
    });

    state.incomingCall = null;
    return;
  }

  try {
    state.callType = data.callType;

    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: data.callType === "video"
    });

    $("#callModal").classList.remove("hidden");
    $("#callModal").classList.toggle("voice-call", data.callType === "voice");
    $("#callStatus").textContent = "Connecting...";
    $("#callUserName").textContent = callerName;
    $("#callAvatar").textContent = initials(callerName);

    $("#localVideo").srcObject = state.localStream;

    const peer = new SimplePeer({
      initiator: false,
      trickle: false,
      stream: state.localStream
    });

    state.peer = peer;

    peer.on("signal", signal => {
      state.socket.emit("call:signal", {
        conversationId: data.conversationId,
        targetUserId: data.callerId,
        signal
      });
    });

    peer.on("stream", stream => {
  state.remoteStream = stream;
  $("#remoteVideo").srcObject = stream;
  $("#callStatus").textContent = "Connected";
  startCallTimer();

  state.socket.emit("call:accept", {
    conversationId: data.conversationId,
    callerId: data.callerId,
    callHistoryId: data.callHistoryId
  });
});

    peer.on("error", error => {
      console.error("Incoming call error:", error);
      toast("Call connection failed.");
      endCall();
    });

    peer.signal(data.offer);

    state.callActive = true;

  } catch (error) {
    console.error("Could not accept call:", error);
    toast("Could not access your microphone or camera.");

    state.socket.emit("call:reject", {
      conversationId: data.conversationId,
      callerId: data.callerId
    });

    endCall();
  }
});

state.socket.on("message:new", message => {
  // Request permission for browser notifications
  const conversationId = Number(message.conversation_id);
  const isActiveConversation =
    conversationId === Number(state.activeId);

  const isOwnMessage =
    Number(message.sender_id) === Number(state.user.id);

// Show a notification when someone else sends a message
if (
  !isOwnMessage &&
  !isActiveConversation &&
  "Notification" in window &&
  Notification.permission === "granted"
) {
  const notification = new Notification(
    message.sender_name || "New message",
    {
      body: message.body || "You received a new message.",
      icon: "/favicon.ico",
      tag: `message-${message.id}`
    }
  );

  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}

  // Update the conversation preview and move it to the top.
  const conversation = state.conversations.find(
    c => Number(c.id) === conversationId
  );

  if (conversation) {
    conversation.last_message = message.body;
    conversation.last_message_at =
      message.created_at || new Date().toISOString();

    // Count unread messages only when the conversation is not open.
    if (!isOwnMessage && !isActiveConversation) {
      conversation.unread_count =
        Number(conversation.unread_count || 0) + 1;
    }

    state.conversations.sort((a, b) =>
      new Date(b.last_message_at || 0) -
      new Date(a.last_message_at || 0)
    );

    renderConversations();
  }

  if (isActiveConversation) {
    appendMessage(message);
  }

  if (!isOwnMessage) {
    state.socket.emit("message:delivered", {
      messageId: message.id
    });

    if (isActiveConversation && !document.hidden) {
      state.socket.emit("message:read", {
        messageId: message.id
      });
    }

    if (!notificationPreferences.notificationsEnabled) return;
    if (isActiveConversation && !document.hidden) return;

    if ("Notification" in window &&
        Notification.permission === "granted") {
      new Notification(message.sender_name || "New message", {
        body: message.body,
        icon: "/favicon.ico"
      });
    }

    if (notificationPreferences.notificationSound) {
      const audio = new Audio("/notification.mp3");
      audio.play().catch(() => {});
    }
  }
});


state.socket.on("message:deleted", data => {
  const messageElement = document.querySelector(
    `[data-message-id="${data.messageId}"]`
  );

  if (data.deleteType === "me") {
    if (messageElement) {
      messageElement.remove();
    }
    return;
  }

  if (data.deleteType === "everyone") {
    if (messageElement) {
      const bubble = messageElement.querySelector(".message-bubble");

      if (bubble) {
        bubble.textContent = "This message was deleted";
        bubble.style.fontStyle = "italic";
        bubble.style.opacity = "0.7";
      }

      const actions = messageElement.querySelector(".message-actions");

      if (actions) actions.remove();

      const replyQuote = messageElement.querySelector(".reply-quote");

      if (replyQuote) replyQuote.remove();
    }

    // Update the conversation preview.
    const conversation = state.conversations.find(
      c => Number(c.id) === Number(state.activeId)
    );

    if (conversation) {
      conversation.last_message = "This message was deleted";
      renderConversations();
    }
  }
});


  state.socket.on("conversation:updated", () => {
    loadConversations();
  });

  state.socket.on("presence:update", event => {
    const userId = Number(event.userId);

    if (event.online === true) {
      state.online.add(userId);
    } else {
      state.online.delete(userId);
    }

    renderConversations();
    renderOnlinePeople();

    if (
      state.activeUser &&
      Number(state.activeUser.id) === userId
    ) {
      renderActiveHeader();
      renderDetails();
    }
  });

  await loadConversations();

  // Load the three settings using one request.
  try {
    const data = await api("/api/settings");
    const settings = data.settings;

    const theme = settings.theme || "light";
    const wallpaper = settings.wallpaper || "default";

    $("#settingsTheme").value = theme;
    $("#settingsWallpaper").value = wallpaper;
    applyAppearance(theme, wallpaper);

    notificationPreferences = {
      notificationsEnabled: settings.notifications_enabled,
      notificationSound: settings.notification_sound
    };

    $("#settingsNotifications").checked =
      notificationPreferences.notificationsEnabled;

    $("#settingsSound").checked =
      notificationPreferences.notificationSound;

    $("#settingsOnlineStatus").checked =
      settings.show_online_status;

  } catch (error) {
    console.error("Could not load user settings:", error);
  }
}

async function loadConversations() {
  const data=await api("/api/conversations"); 
  state.conversations=data.conversations;

  renderConversations();
  renderOnlinePeople();

  if(state.activeId && !state.conversations.some(c=>Number(c.id)===Number(state.activeId))) {
    state.activeId=null; state.activeUser=null; $("#messagePanel").classList.add("hidden"); $("#welcomePanel").classList.remove("hidden");
  }
}
function conversationName(c) { return c.is_group?c.title:(c.other_user?.displayName || "Conversation"); }

function renderConversations() {
  const query = $("#chatSearch").value.trim().toLowerCase();

  const activeFilter = document.querySelector(".mobile-chat-tab.active")?.dataset.filter || "all";

const items = state.conversations.filter(c => {
  const matchesSearch =
    conversationName(c).toLowerCase().includes(query) ||
    (c.other_user?.username || "").toLowerCase().includes(query);

  const matchesFilter =
  activeFilter === "all"
    ? !c.is_group
    : activeFilter === "groups" && c.is_group;

  return matchesSearch && matchesFilter;
});

  $("#conversationList").innerHTML = items.length
    ? items.map(c => {
        const u = c.other_user || {};
        const name = conversationName(c);
        const online = u.id && !c.is_group && isUserOnline(u.id);
        const unread = Number(c.unread_count || 0);

        return `
          <div class="conversation-item ${Number(c.id) === Number(state.activeId) ? "active" : ""} ${unread > 0 ? "unread" : ""}" data-id="${c.id}">
            <div class="avatar-presence">
              <div class="avatar" style="background:${escapeHtml(u.avatarColor || "#7868e6")}">
                ${escapeHtml(initials(name))}
              </div>

              ${u.id && !c.is_group
                ? `<span class="presence-dot ${online ? "online" : "offline"}"></span>`
                : ""}
            </div>

            <div class="conversation-meta">
              <strong>${escapeHtml(name)}</strong>
              <small>${escapeHtml(c.last_message || "Say hello 👋")}</small>
            </div>

            ${unread > 0
              ? `<span class="unread-badge">${unread > 99 ? "99+" : unread}</span>`
              : ""}
          </div>
        `;
      }).join("")
    : '<div class="empty-side">No conversations yet. Start one with the + button.</div>';

  document.querySelectorAll(".conversation-item").forEach(el => {
    el.addEventListener("click", () =>
      openConversation(Number(el.dataset.id))
    );
  });
}

function isUserOnline(userId) {
  return state.online.has(Number(userId));
}

function renderOnlinePeople() {
  const container = $("#onlinePeople");
  const count = $("#onlineCount");

  if (!container || !count) return;

  const people = new Map();

  state.conversations.forEach(c => {
    const user = c.other_user;

    if (user && user.id && !c.is_group && isUserOnline(user.id)) {
      people.set(Number(user.id), {
        user,
        conversationId: c.id
      });
    }
  });

  const onlinePeople = [...people.values()];
  count.textContent = onlinePeople.length;

  if (!onlinePeople.length) {
    container.innerHTML =
      '<div class="online-empty">No one online right now</div>';
    return;
  }

  container.innerHTML = onlinePeople.map(({ user, conversationId }) => `
    <div class="online-person" data-conversation-id="${conversationId}">
      <div class="online-avatar-wrap">
        <div class="online-avatar" style="display:flex;align-items:center;justify-content:center;color:white;font-weight:700;background:${escapeHtml(user.avatarColor || "#eee9ff")}">
          ${escapeHtml(initials(user.displayName))}
        </div>
        <span class="online-dot"></span>
      </div>
      <span class="online-person-name">
        ${escapeHtml(user.displayName.split(" ")[0])}
      </span>
    </div>
  `).join("");

  container.querySelectorAll(".online-person").forEach(person => {
    person.addEventListener("click", () => {
      openConversation(Number(person.dataset.conversationId));
    });
  });
}

function renderOnlinePeople() {
  const container = $("#onlinePeople");
  const count = $("#onlineCount");

  if (!container || !count) return;

  // Get unique people from existing conversations.
  const people = new Map();

  state.conversations.forEach(c => {
    const user = c.other_user;

    if (
      user &&
      user.id &&
      !c.is_group &&
      isUserOnline(user.id)
    ) {
      people.set(Number(user.id), {
        user,
        conversationId: c.id
      });
    }
  });

  const onlinePeople = [...people.values()];

  count.textContent = onlinePeople.length;

  if (!onlinePeople.length) {
    container.innerHTML =
      '<div class="online-empty">No one online right now</div>';
    return;
  }

  container.innerHTML = onlinePeople.map(({ user, conversationId }) => `
    <div class="online-person" data-conversation-id="${conversationId}" title="${escapeHtml(user.displayName)}">
      <div class="online-avatar-wrap">
        <div class="online-avatar" style="background:${escapeHtml(user.avatarColor || "#eee9ff")}; display:flex; align-items:center; justify-content:center; color:white; font-weight:700;">
          ${escapeHtml(initials(user.displayName))}
        </div>
        <span class="online-dot"></span>
      </div>
      <span class="online-person-name">
        ${escapeHtml(user.displayName.split(" ")[0])}
      </span>
    </div>
  `).join("");

  container.querySelectorAll(".online-person").forEach(person => {
    person.addEventListener("click", () => {
      openConversation(Number(person.dataset.conversationId));
    });
  });
}


function renderActiveHeader() {
  const user = state.activeUser;
  const conversation = state.conversations.find(
    c => Number(c.id) === Number(state.activeId)
  );

  if (!conversation) return;

  const name = conversationName(conversation);
  const online = user && !conversation.is_group && isUserOnline(user.id);

  $("#activeChatHead").innerHTML = `
    <div class="avatar-presence">
      <div class="avatar" style="background:${escapeHtml(user?.avatarColor || "#7868e6")}">
        ${escapeHtml(initials(name))}
      </div>
      ${user && !conversation.is_group
        ? `<span class="presence-dot ${online ? "online" : "offline"}"></span>`
        : ""}
    </div>
    <div class="chat-user-info">
      <strong>${escapeHtml(name)}</strong>
      <small class="${user && !conversation.is_group ? (online ? "online-text" : "offline-text") : ""}">
        ${user && !conversation.is_group ? (online ? "Online" : "Offline") : "Group conversation"}
      </small>
    </div>
  `;
}

async function openConversation(id) {
  const c=state.conversations.find(x=>Number(x.id)===id); if(!c)return;
  state.activeId=id; 
  console.log("OPENED CONVERSATION ID:", id);
  $(".app-shell")?.classList.add("chat-open");
  $("#appView").classList.add("chat-open");
  state.activeUser=c.other_user||null;
  $("#welcomePanel").classList.add("hidden"); $("#messagePanel").classList.remove("hidden");
  renderActiveHeader();
  renderConversations(); renderDetails();
  state.socket.emit("conversation:join",id);
  const data=await api(`/api/conversations/${id}/messages`);
  if(state.activeId!==id)return;
  $("#messages").innerHTML="";
 
data.messages.forEach(message => {
  appendMessage(message);

  // Mark messages from other users as read.
  if (Number(message.sender_id) !== Number(state.user.id)) {
    state.socket.emit("message:read", {
      messageId: message.id
    });
  }
});

// Clear the unread badge immediately.
c.unread_count = 0;
renderConversations();


$("#messages").scrollTop = $("#messages").scrollHeight;
  $("#messageInput").focus();
}

function appendMessage(message) {
  if (Number(message.conversation_id) !== Number(state.activeId)) return;
  if (document.querySelector(`[data-message-id="${message.id}"]`)) return;

  const mine = Number(message.sender_id) === Number(state.user.id);
  const time = new Date(message.created_at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  let receipt = "";

  if (mine) {
    const recipients = Number(message.recipient_count || 0);
    const delivered = Number(message.delivered_count || 0);
    const read = Number(message.read_count || 0);

    if (recipients > 0 && read === recipients) {
      receipt = '<span class="message-receipt read" title="Read">✓✓</span>';
    } else if (recipients > 0 && delivered === recipients) {
      receipt = '<span class="message-receipt delivered" title="Delivered">✓✓</span>';
    } else {
      receipt = '<span class="message-receipt sent" title="Sent">✓</span>';
    }
  }

  const el = document.createElement("div");
  el.className = `message ${mine ? "mine" : ""}`;
  el.dataset.messageId = message.id;

  const deleted = message.deleted_for_everyone;

  el.innerHTML = `
    ${message.reply_body && !deleted ? `
      <div class="reply-quote">
        <strong>${escapeHtml(message.reply_sender_name || "User")}</strong>
        <span>${escapeHtml(message.reply_body)}</span>
      </div>
    ` : ""}

    <div class="message-bubble">${deleted ? "This message was deleted" : escapeHtml(message.body)}</div>

    <span class="message-time">
      ${mine ? "You" : escapeHtml(message.sender_name || "")} · ${time}
      ${receipt}
    </span>
  `;

  $("#messages").appendChild(el);

    let pressTimer;

  const messageBubble = el.querySelector(".message-bubble");

  messageBubble.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  showDeleteMenu(message);
});

let startX = 0;
let startY = 0;
let isDragging = false;

function startReplyDrag(x, y) {
  startX = x;
  startY = y;
  isDragging = true;
}

function moveReplyDrag(x, y) {
  if (!isDragging) return;

  const distanceX = x - startX;
  const distanceY = Math.abs(y - startY);

  if (distanceX > 0 && distanceY < 50) {
    messageBubble.style.transform =
      `translateX(${Math.min(distanceX, 35)}px)`;
  }
}

function finishReplyDrag(x, y) {
  if (!isDragging) return;

  isDragging = false;

  const distanceX = x - startX;
  const distanceY = Math.abs(y - startY);

  messageBubble.style.transform = "";

  if (distanceX > 70 && distanceY < 50) {
    state.replyingTo = message;

    $("#replyPreviewName").textContent =
      `Replying to ${message.sender_name || "User"}`;

    $("#replyPreviewText").textContent = message.body;
    $("#replyPreview").style.display = "flex";
    $("#messageInput").placeholder = "Write your reply...";
    $("#messageInput").focus();
  }
}

// Laptop mouse drag
messageBubble.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  startReplyDrag(event.clientX, event.clientY);
});

document.addEventListener("mousemove", (event) => {
  moveReplyDrag(event.clientX, event.clientY);
});

document.addEventListener("mouseup", (event) => {
  finishReplyDrag(event.clientX, event.clientY);
});

let longPressTimer;

messageBubble.addEventListener("touchstart", () => {
  longPressTimer = setTimeout(() => {
    showDeleteMenu(message);
  }, 600);
}, { passive: true });

messageBubble.addEventListener("touchend", () => {
  clearTimeout(longPressTimer);
});

messageBubble.addEventListener("touchmove", () => {
  clearTimeout(longPressTimer);
}, { passive: true });

messageBubble.addEventListener("touchcancel", () => {
  clearTimeout(longPressTimer);
});

// Phone swipe
messageBubble.addEventListener("touchstart", (event) => {
  const touch = event.changedTouches[0];
  startReplyDrag(touch.clientX, touch.clientY);
}, { passive: true });

messageBubble.addEventListener("touchmove", (event) => {
  const touch = event.changedTouches[0];
  moveReplyDrag(touch.clientX, touch.clientY);
}, { passive: true });

messageBubble.addEventListener("touchend", (event) => {
  const touch = event.changedTouches[0];
  finishReplyDrag(touch.clientX, touch.clientY);
});

messageBubble.addEventListener("touchcancel", () => {
  isDragging = false;
  messageBubble.style.transform = "";
});

  $("#messages").scrollTop = $("#messages").scrollHeight;
}


function showDeleteMenu(message) {
  if (message.deleted_for_everyone) return;

  const mine = Number(message.sender_id) === Number(state.user.id);
  const menu = $("#messageContextMenu");

  menu.style.display = "block";

  const replyBtn = $("#replyContextBtn");
  const deleteMeBtn = $("#deleteMeContextBtn");
  const deleteEveryoneBtn = $("#deleteEveryoneContextBtn");

  deleteEveryoneBtn.style.display = mine ? "block" : "none";

  const messageElement = document.querySelector(
    `[data-message-id="${message.id}"]`
  );

  const rect = messageElement.getBoundingClientRect();

  menu.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - 210))}px`;
  menu.style.top = `${Math.min(rect.bottom + 5, window.innerHeight - 160)}px`;

  replyBtn.onclick = () => {
    state.replyingTo = message;

    $("#replyPreviewName").textContent =
      `Replying to ${message.sender_name || "User"}`;

    $("#replyPreviewText").textContent = message.body;
    $("#replyPreview").style.display = "flex";
    $("#messageInput").placeholder = "Write your reply...";
    $("#messageInput").focus();

    menu.style.display = "none";
  };

  deleteMeBtn.onclick = () => {
    menu.style.display = "none";
    deleteMessage(message.id, "me");
  };

  deleteEveryoneBtn.onclick = (event) => {
  event.preventDefault();
  event.stopPropagation();

  menu.style.display = "none";
  deleteMessage(message.id, "everyone");
};
}

document.addEventListener("pointerdown", (event) => {
  const menu = $("#messageContextMenu");

  if (
    menu &&
    !menu.contains(event.target) &&
    !event.target.closest(".message-bubble")
  ) {
    menu.style.display = "none";
  }
});

function deleteMessage(messageId, deleteType) {
  console.log("Delete clicked:", messageId, deleteType);

  state.socket.emit("message:delete", {
    messageId,
    deleteType
  }, (result) => {
    console.log("Delete server response:", result);

    if (!result?.ok) {
      toast(result?.error || "Could not delete message.");
      return;
    }

    toast(
      deleteType === "everyone"
        ? "Message deleted for everyone."
        : "Message deleted for you."
    );
  });
}


$("#cancelReplyBtn").addEventListener("click", () => {
  state.replyingTo = null;

  $("#replyPreview").style.display = "none";
  $("#messageInput").placeholder = "Write a message...";
});

$("#messageForm").addEventListener("submit",event=>{
  event.preventDefault(); const body=$("#messageInput").value.trim();
  if(!body||!state.activeId)return;
  state.socket.emit("message:send", {
  conversationId: state.activeId,
  body,
  replyToId: state.replyingTo?.id || null
}, result => {
  if (!result?.ok) {
    toast(result?.error || "Message could not be sent.");
    return;
  }

  $("#messageInput").value = "";
  state.replyingTo = null;
$("#replyPreview").style.display = "none";
$("#messageInput").placeholder = "Write a message...";
});
});
function renderDetails() {
  const u=state.activeUser; const c=state.conversations.find(x=>Number(x.id)===Number(state.activeId));
  if(!u||!c){ $("#detailsContent").innerHTML='<div class="detail-placeholder">Your conversation details will appear here.</div>';return; }
  const online = isUserOnline(u.id);

$("#detailsContent").innerHTML = `
  <div class="avatar detail-avatar" style="background:${escapeHtml(u.avatarColor)}">
    ${escapeHtml(initials(u.displayName))}
  </div>
  <h3>${escapeHtml(u.displayName)}</h3>
  <p>@${escapeHtml(u.username)}</p>
  <p class="online-label ${online ? "online-text" : "offline-text"}">
    <span class="presence-dot ${online ? "online" : "offline"}"></span>
    ${online ? "Online" : "Offline"}
  </p>
`;
}
function openModal() {
  $("#searchModal").classList.remove("hidden");
  $("#userSearch").value = "";
  $("#userResults").innerHTML = '<p class="search-prompt">Type at least 2 characters to find people.</p>';
  $("#userSearch").focus();
}function closeModal() { $("#searchModal").classList.add("hidden"); }
$("#welcomeNewChat")?.addEventListener("click", openModal);
$("#closeModal").addEventListener("click",closeModal); $("#searchModal").addEventListener("click",e=>{if(e.target.dataset.close)closeModal();});
$("#closeDetails").addEventListener("click",()=>$("#detailsPanel").classList.add("hidden"));
$("#detailsBtn").addEventListener("click",()=>$("#detailsPanel").classList.toggle("hidden"));
$("#chatSearch").addEventListener("input",renderConversations);
// Mobile chat tabs
document.querySelectorAll(".mobile-chat-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const filter = tab.dataset.filter;

    if (filter === "calls") {
      document.getElementById("navCalls")?.click();
      return;
    }

    document.querySelectorAll(".mobile-chat-tab").forEach(item => {
      item.classList.remove("active");
    });

    tab.classList.add("active");
    renderConversations();
  });
});
let searchDelay;
$("#userSearch").addEventListener("input",()=>{
  clearTimeout(searchDelay); const q=$("#userSearch").value.trim();
  if(q.length<2){$("#userResults").innerHTML='<p class="search-prompt">Type at least 2 characters to find people.</p>';return;}
  searchDelay=setTimeout(async()=>{
    try{
      const data=await api(`/api/users/search?q=${encodeURIComponent(q)}`);
      $("#userResults").innerHTML=data.users.length?data.users.map(u=>`<div class="user-result"><div class="avatar" style="background:${escapeHtml(u.avatarColor)}">${escapeHtml(initials(u.displayName))}</div><div class="user-result-info"><strong>${escapeHtml(u.displayName)}</strong><small>@${escapeHtml(u.username)}</small></div><button data-user-id="${u.id}">Message</button></div>`).join(""):'<p class="search-prompt">No people found. Try another name.</p>';
      document.querySelectorAll("[data-user-id]").forEach(btn=>btn.addEventListener("click",async()=>{
        try{const result=await api("/api/conversations",{method:"POST",body:JSON.stringify({userId:Number(btn.dataset.userId)})});closeModal();await loadConversations();await openConversation(result.conversationId);}
        catch(err){toast(err.message);}
      }));
    }catch(err){toast(err.message);}
  },250);
});
$("#logoutBtn").addEventListener("click",async()=>{
  try{await api("/api/auth/logout",{method:"POST"});}catch(e){}
  if(state.socket)state.socket.disconnect(); state.socket=null; state.user=null; state.activeId=null; showAuth("login");
});
(async()=>{
  showAuth("login");
  try{const data=await api("/api/me");if(data.user)await enterApp(data.user);}catch(err){console.error(err);}
})();


// Mobile bottom navigation
$("#navChats")?.addEventListener("click", () => {
  $("#conversationList")?.scrollIntoView({
    behavior: "smooth",
    block: "nearest"
  });

  document.querySelectorAll(".bottom-nav-item")
    .forEach(item => item.classList.remove("active"));

  $("#navChats")?.classList.add("active");
});

$("#navSearch")?.addEventListener("click", () => {
  $("#chatSearch")?.focus();

  document.querySelectorAll(".bottom-nav-item")
    .forEach(item => item.classList.remove("active"));

  $("#navSearch")?.classList.add("active");
});

$("#navNewChat")?.addEventListener("click", () => {
  openModal();

  document.querySelectorAll(".bottom-nav-item")
    .forEach(item => item.classList.remove("active"));

  $("#navNewChat")?.classList.add("active");
});

// CALL HISTORY NAVIGATION
$("#navCalls")?.addEventListener("click", openCalls);

$("#backToChats")?.addEventListener("click", () => {
  // Return to the conversations screen.
  $("#appView")?.classList.remove("chat-open");

  // Clear the active conversation.
  state.activeId = null;
  state.activeUser = null;

  // Show the welcome screen.
  $("#messagePanel")?.classList.add("hidden");
  $("#welcomePanel")?.classList.remove("hidden");

  // Refresh the conversation list.
  renderConversations();
});


// ========================================
// HITHERE SETTINGS NAVIGATION
// ========================================

const settingsView = $("#settingsView");
const callsView = $("#callsView");
console.log("Calls element found:", callsView);

function openSettings() {
  if (!settingsView) return;

  settingsView.classList.remove("hidden");

  // Fill in the current user's profile
  if (state.user) {
    $("#settingsDisplayName").value = state.user.displayName || "";
    $("#settingsUsername").value = state.user.username || "";
    $("#settingsProfileName").textContent = state.user.displayName || "Your name";
    $("#settingsProfileHandle").textContent = "@" + (state.user.username || "username");

    $("#settingsAvatar").textContent = initials(state.user.displayName);
    $("#settingsAvatar").style.background = state.user.avatarColor || "#7868e6";

    $("#settingsAvatarColor").value = state.user.avatarColor || "#7868e6";
  }

  document.querySelectorAll(".bottom-nav-item")
    .forEach(item => item.classList.remove("active"));

  $("#navSettings")?.classList.add("active");
}

function openCalls() {
  console.log("Calls button clicked");
  
  if (!callsView) return;

  callsView.classList.remove("hidden");
  console.log("Calls view:", callsView);
console.log("Calls hidden:", callsView.classList.contains("hidden"));

  settingsView?.classList.add("hidden");
  welcomePanel?.classList.add("hidden");
  messagePanel?.classList.add("hidden");

  document.querySelectorAll(".bottom-nav-item")
    .forEach(item => item.classList.remove("active"));

  $("#navCalls")?.classList.add("active");

  loadCallHistory();
}

async function loadCallHistory() {
  const list = $("#callHistoryList");

  if (!list) return;

  list.innerHTML = '<p class="empty-state">Loading your calls...</p>';

  try {
    const data = await api("/api/calls");

    if (!data.calls || data.calls.length === 0) {
      list.innerHTML = '<p class="empty-state">No calls yet. Your call history will appear here.</p>';
      return;
    }

    list.innerHTML = data.calls.map(call => {
      const outgoing = Number(call.caller_id) === Number(state.user.id);

      const personName = outgoing
        ? call.receiver_name || call.receiver_username
        : call.caller_name || call.caller_username;

      const missed = call.status === "missed";
      const rejected = call.status === "rejected";

      const direction = outgoing ? "Outgoing" : "Incoming";

      const date = new Date(call.started_at).toLocaleString();

      const duration = Number(call.duration_seconds || 0);
      const minutes = Math.floor(duration / 60);
      const seconds = duration % 60;

      return `
        <div class="call-history-item">
          <div class="call-history-info">
            <strong>${personName || "Unknown user"}</strong>
            <span>${direction} · ${call.call_type} call</span>
            <small>${date}</small>
            <small>${missed ? "Missed" : rejected ? "Rejected" : `${minutes}m ${seconds}s`}</small>
          </div>

          <button
            class="call-again-btn"
            data-conversation-id="${call.conversation_id || ""}"
            data-call-type="${call.call_type}"
            type="button"
          >
            Call again
          </button>
        </div>
      `;
    }).join("");

  } catch (error) {
    console.error("Call history error:", error);

    list.innerHTML = '<p class="empty-state">Unable to load calls. Please try again.</p>';
  }
}

// CALL AGAIN FROM HISTORY
$("#callHistoryList")?.addEventListener("click", async (event) => {
  const button = event.target.closest(".call-again-btn");

  if (!button) return;

  const conversationId = Number(button.dataset.conversationId);
  const callType = button.dataset.callType;

  if (!conversationId) {
    toast("This call has no available conversation.");
    return;
  }

  const conversation = state.conversations.find(
    c => Number(c.id) === conversationId
  );

  if (!conversation) {
    toast("Conversation not found. Please refresh your chats.");
    return;
  }

  await openConversation(conversationId);

  startCall(callType === "video" ? "video" : "voice");
});

function closeSettings() {
  settingsView?.classList.add("hidden");

  document.querySelectorAll(".bottom-nav-item")
    .forEach(item => item.classList.remove("active"));

  $("#navChats")?.classList.add("active");
}

// Desktop settings button
$("#settingsBtn")?.addEventListener("click", openSettings);
document.getElementById("mobileSearchBtn")?.addEventListener("click", () => {
  document.getElementById("chatSearch")?.focus();
});

document.getElementById("mobileSettingsBtn")?.addEventListener("click", () => {
  document.getElementById("settingsBtn")?.click();
});

const mobileProfileBtn = document.getElementById("mobileProfileBtn");

mobileProfileBtn?.addEventListener("click", () => {
  document.getElementById("settingsBtn")?.click();
});

const updateMobileAvatar = () => {
  const originalAvatar = document.getElementById("myAvatar");
  const mobileAvatar = document.getElementById("mobileProfileAvatar");

  if (originalAvatar && mobileAvatar) {
    mobileAvatar.textContent = originalAvatar.textContent.trim().charAt(0) || "H";
  }
};

updateMobileAvatar();

// Mobile settings button
$("#navSettings")?.addEventListener("click", openSettings);

// Close settings
$("#closeSettings")?.addEventListener("click", closeSettings);
$("#closeCalls")?.addEventListener("click", () => {
  callsView?.classList.add("hidden");

  document.querySelectorAll(".bottom-nav-item")
    .forEach(item => item.classList.remove("active"));

  $("#navChats")?.classList.add("active");
});

// ========================================
// SETTINGS SECTION NAVIGATION
// ========================================

document.querySelectorAll(".settings-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    const section = tab.dataset.setting;

    document.querySelectorAll(".settings-tab")
      .forEach(item => item.classList.remove("active"));

    document.querySelectorAll(".settings-panel")
      .forEach(panel => panel.classList.remove("active"));

    tab.classList.add("active");

    const selectedPanel = $("#setting-" + section);

    if (selectedPanel) {
      selectedPanel.classList.add("active");
    }
  });
});


// ========================================
// PROFILE PREVIEW
// ========================================

$("#settingsDisplayName")?.addEventListener("input", event => {
  $("#settingsProfileName").textContent =
    event.target.value.trim() || "Your name";

  $("#settingsAvatar").textContent =
    initials(event.target.value);
});

$("#settingsUsername")?.addEventListener("input", event => {
  $("#settingsProfileHandle").textContent =
    "@" + event.target.value.trim();
});

$("#settingsAvatarColor")?.addEventListener("change", event => {
  $("#settingsAvatar").style.background = event.target.value;
});


// ========================================
// PASSWORD FORM VISIBILITY
// ========================================

$("#openPasswordForm")?.addEventListener("click", () => {
  const form = $("#passwordSettingsForm");

  form?.classList.toggle("hidden");

  if (!form?.classList.contains("hidden")) {
    $("#currentPassword")?.focus();
  }
});

// ========================================
// SAVE PROFILE SETTINGS
// ========================================

const profileForm = $("#profileSettingsForm");

profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const message = $("#profileSettingsMessage");

  const profile = {
    displayName: $("#settingsDisplayName").value.trim(),
    username: $("#settingsUsername").value.trim().toLowerCase(),
    avatarColor: $("#settingsAvatarColor").value
  };

  try {
    message.textContent = "Saving your profile...";

    const result = await api("/api/profile", {
      method: "PUT",
      body: JSON.stringify(profile)
    });

    // Update the current user
    state.user = result.user;

    // Update the sidebar profile
    $("#myName").textContent = result.user.displayName;
    $("#myHandle").textContent = "@" + result.user.username;
    $("#myAvatar").textContent = initials(result.user.displayName);
    $("#myAvatar").style.background = result.user.avatarColor;

    // Update the settings preview
    $("#settingsProfileName").textContent = result.user.displayName;
    $("#settingsProfileHandle").textContent = "@" + result.user.username;
    $("#settingsAvatar").textContent = initials(result.user.displayName);
    $("#settingsAvatar").style.background = result.user.avatarColor;

    message.textContent = "Profile updated successfully!";
    toast("Your profile has been updated.");

  } catch (error) {
    message.textContent = error.message;
    toast(error.message);
  }
});

// ========================================
// HITHERE APPEARANCE SETTINGS
// ========================================

function applyAppearance(theme, wallpaper) {
  // Apply theme
  document.body.classList.toggle("dark-mode", theme === "dark");

  // Apply chat wallpaper
  const messages = $("#messages");

  if (messages) {
    messages.classList.remove(
      "wallpaper-default",
      "wallpaper-lavender",
      "wallpaper-cream",
      "wallpaper-mint"
    );

    messages.classList.add(`wallpaper-${wallpaper}`);
  }
}


// Load saved appearance preferences
async function loadAppearanceSettings() {
  try {
    const data = await api("/api/settings");
    const settings = data.settings;

    const theme = settings.theme || "light";
    const wallpaper = settings.wallpaper || "default";

    $("#settingsTheme").value = theme;
    $("#settingsWallpaper").value = wallpaper;

    applyAppearance(theme, wallpaper);

  } catch (error) {
    console.error("Could not load appearance settings:", error);
  }
}


// Save appearance preferences
async function saveAppearanceSettings() {
  const theme = $("#settingsTheme").value;
  const wallpaper = $("#settingsWallpaper").value;

  applyAppearance(theme, wallpaper);

  try {
    await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ theme, wallpaper })
    });

    toast("Appearance settings saved.");

  } catch (error) {
    toast(error.message);
  }
}


// Listen for theme changes
$("#settingsTheme")?.addEventListener("change", saveAppearanceSettings);


// Listen for wallpaper changes
$("#settingsWallpaper")?.addEventListener("change", saveAppearanceSettings);


// ========================================
// HITHERE NOTIFICATION SETTINGS
// ========================================

let notificationPreferences = {
  notificationsEnabled: true,
  notificationSound: true
};

async function loadNotificationSettings() {
  try {
    const data = await api("/api/settings");
    const settings = data.settings;
    if (
      settings.notifications_enabled &&
      "Notification" in window &&
      Notification.permission === "default"
) {
      await Notification.requestPermission();
}

    notificationPreferences = {
      notificationsEnabled: settings.notifications_enabled,
      notificationSound: settings.notification_sound
    };

    $("#settingsNotifications").checked =
      notificationPreferences.notificationsEnabled;

    $("#settingsSound").checked =
      notificationPreferences.notificationSound;

  } catch (error) {
    console.error("Could not load notification settings:", error);
  }
}

async function saveNotificationSettings() {
  const notificationsEnabled = $("#settingsNotifications").checked;
  const notificationSound = $("#settingsSound").checked;

  try {
    await api("/api/settings/notifications", {
      method: "PUT",
      body: JSON.stringify({
        notificationsEnabled,
        notificationSound
      })
    });

    notificationPreferences = {
      notificationsEnabled,
      notificationSound
    };

    if (
      notificationsEnabled &&
      "Notification" in window &&
      Notification.permission === "default"
    ) {
      await Notification.requestPermission();
    }

    toast("Notification settings saved.");

  } catch (error) {
    toast(error.message);
  }
}
$("#settingsNotifications")?.addEventListener(
  "change",
  saveNotificationSettings
);

$("#settingsSound")?.addEventListener(
  "change",
  saveNotificationSettings
);

// LOAD PRIVACY SETTINGS
async function loadPrivacySettings() {
  try {
    const data = await api("/api/settings");
    $("#settingsOnlineStatus").checked =
      data.settings.show_online_status;
  } catch (error) {
    console.error("Could not load privacy settings:", error);
  }
}

// SAVE PRIVACY SETTINGS
async function savePrivacySettings() {
  const showOnlineStatus = $("#settingsOnlineStatus").checked;

  try {
    await api("/api/settings/privacy", {
      method: "PUT",
      body: JSON.stringify({ showOnlineStatus })
    });

    toast("Privacy settings saved.");
  } catch (error) {
    toast(error.message);
  }
}

$("#settingsOnlineStatus")?.addEventListener(
  "change",
  savePrivacySettings
);

// CHANGE PASSWORD
$("#passwordSettingsForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();

  const currentPassword = $("#currentPassword").value;
  const newPassword = $("#newPassword").value;
  const confirmPassword = $("#confirmPassword").value;
  const message = $("#passwordSettingsMessage");

  message.textContent = "";

  try {
    const data = await api("/api/settings/password", {
      method: "PUT",
      body: JSON.stringify({
        currentPassword,
        newPassword,
        confirmPassword
      })
    });

    message.textContent = data.message;
    message.style.color = "green";

    $("#passwordSettingsForm").reset();

    toast("Password changed successfully.");

  } catch (error) {
    message.textContent = error.message;
    message.style.color = "#d64545";
  }
});

// VOICE AND VIDEO CALL BUTTONS

$("#voiceCallBtn")?.addEventListener("click", () => {
  startCall("voice");
});

$("#videoCallBtn")?.addEventListener("click", () => {
  startCall("video");
});

// END CALL BUTTONS

$("#endCallBtn")?.addEventListener("click", () => {
  endCall();
});

$("#closeCallBtn")?.addEventListener("click", () => {
  endCall();
});

// MUTE MICROPHONE

$("#muteCallBtn")?.addEventListener("click", () => {
  const track = state.localStream?.getAudioTracks()[0];

  if (!track) return;

  track.enabled = !track.enabled;

  $("#muteCallBtn").innerHTML = track.enabled
  ? '<i data-lucide="mic"></i>'
  : '<i data-lucide="mic-off"></i>';

lucide.createIcons();
});

// TOGGLE CAMERA

$("#cameraCallBtn")?.addEventListener("click", () => {
  const track = state.localStream?.getVideoTracks()[0];

  if (!track) {
    toast("Camera is not active for this voice call.");
    return;
  }

  track.enabled = !track.enabled;

  $("#cameraCallBtn").innerHTML = track.enabled
  ? '<i data-lucide="video"></i>'
  : '<i data-lucide="video-off"></i>';

lucide.createIcons();
});

// Organise mobile header controls
const mobileActions = document.querySelector(".mobile-home-actions");

if (mobileActions) {
  const controls = [
    document.getElementById("myName"),
    document.getElementById("enableNotificationsBtn"),
    document.getElementById("mobileSearchBtn"),
    document.getElementById("mobileProfileBtn"),
    document.getElementById("logoutBtn")
  ];

  controls.forEach(element => {
    if (!element) return;

    if (!element.dataset.headerPlaceholder) {
      const placeholder = document.createComment("header-control");
      element.parentNode.insertBefore(placeholder, element);
      element.dataset.headerPlaceholder = "true";
      element._headerPlaceholder = placeholder;
    }

    mobileActions.appendChild(element);
  });
}