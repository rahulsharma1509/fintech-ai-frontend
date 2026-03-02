import "./App.css";
import { useEffect, useState, useRef, useCallback } from "react";
import SendbirdChat from "@sendbird/chat";
import { GroupChannelModule, GroupChannelHandler } from "@sendbird/chat/groupChannel";
import { initializeApp, getApps } from "firebase/app";
import { getMessaging, getToken, onMessage } from "firebase/messaging";

const APP_ID      = process.env.REACT_APP_SENDBIRD_APP_ID;
const BOT_ID      = process.env.REACT_APP_BOT_ID || "support_bot";
const BACKEND_URL = "https://fintech-ai-backend-r8ap.onrender.com";

// Firebase web config — set these in .env as REACT_APP_FIREBASE_*
// If not set, push notifications are silently disabled.
const FIREBASE_CONFIG = {
  apiKey:            process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain:        process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.REACT_APP_FIREBASE_APP_ID,
};
const FIREBASE_VAPID_KEY = process.env.REACT_APP_FIREBASE_VAPID_KEY;

function App() {
  const [userId, setUserId]                     = useState("");
  const [inputUserId, setInputUserId]           = useState("");
  const [channels, setChannels]                 = useState([]);
  const [selectedChannel, setSelectedChannel]   = useState(null);
  const [messages, setMessages]                 = useState([]);
  const [text, setText]                         = useState("");
  const [isLoggedIn, setIsLoggedIn]             = useState(false);
  const [isConnecting, setIsConnecting]         = useState(false);
  const [isAutoLogging, setIsAutoLogging]       = useState(true);
  const [isSending, setIsSending]               = useState(false);
  const [typingUsers, setTypingUsers]           = useState([]);
  const [unreadMap, setUnreadMap]               = useState({});
  const [searchQuery, setSearchQuery]           = useState("");
  const [loginError, setLoginError]             = useState("");
  const [faqContent, setFaqContent]             = useState(null);
  const [paymentNotice, setPaymentNotice]       = useState(null);
  const [isMobile, setIsMobile]                 = useState(window.innerWidth < 768);
  const [showSidebarOnMobile, setShowSidebarOnMobile] = useState(true);
  const [isCreatingTicket, setIsCreatingTicket] = useState(false);

  const sbRef                 = useRef(null);
  const selectedChannelRef    = useRef(null);
  const bottomRef             = useRef(null);

  useEffect(() => { selectedChannelRef.current = selectedChannel; }, [selectedChannel]);

  // ── Responsive ──────────────────────────────────────────────────────
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (!selectedChannel && isMobile) setShowSidebarOnMobile(true);
  }, [selectedChannel, isMobile]);

  // ── Auto-login on refresh ───────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem("sb_user_id");
    if (saved) { setInputUserId(saved); loginWithId(saved); }
    else        { setIsAutoLogging(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Stripe redirect detection ────────────────────────────────────────
  useEffect(() => {
    const params  = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    const txn     = params.get("txn");
    if (payment && txn) {
      setPaymentNotice({ type: payment, txnId: txn });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // ── Auto-scroll ──────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── FCM push notifications ───────────────────────────────────────────
  // Runs once after login. Requests browser notification permission,
  // gets the FCM registration token, and registers it with the backend.
  // No-ops silently if Firebase env vars are not configured.
  useEffect(() => {
    if (!isLoggedIn || !userId) return;
    if (!FIREBASE_CONFIG.apiKey) return; // Firebase not configured — skip
    (async () => {
      try {
        if (!("Notification" in window)) return; // browser doesn't support notifications
        const permission = await Notification.requestPermission();
        if (permission !== "granted") return;

        // Register service worker for background messages
        if ("serviceWorker" in navigator) {
          const reg = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
          // Send Firebase config to the SW (it can't read env vars)
          if (reg.active) {
            reg.active.postMessage({ type: "FIREBASE_CONFIG", config: FIREBASE_CONFIG });
          }
        }

        const app       = getApps().length === 0 ? initializeApp(FIREBASE_CONFIG) : getApps()[0];
        const messaging = getMessaging(app);

        const token = await getToken(messaging, { vapidKey: FIREBASE_VAPID_KEY }).catch(() => null);
        if (token) {
          await fetch(`${BACKEND_URL}/register-push-token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, fcmToken: token }),
          }).catch(() => {}); // non-fatal
        }

        // Show foreground notifications as a subtle toast in the page title
        onMessage(messaging, (payload) => {
          const title = payload.notification?.title || "MySupp";
          const body  = payload.notification?.body  || "";
          document.title = `🔔 ${title} — MySupp`;
          setTimeout(() => { document.title = "MySupp"; }, 6000);
          console.log("[FCM] Foreground message:", title, body);
        });
      } catch (err) {
        console.warn("[FCM] Push setup failed:", err.message);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, userId]);

  // ── Login ────────────────────────────────────────────────────────────
  const login = async () => {
    if (!inputUserId.trim()) return;
    await loginWithId(inputUserId.trim());
  };

  const loginWithId = async (id) => {
    setIsConnecting(true);
    setLoginError("");
    try {
      if (BACKEND_URL) {
        try {
          const res = await fetch(`${BACKEND_URL}/register-user`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: id }),
          });
          if (res.status === 403) {
            const data = await res.json().catch(() => ({}));
            setLoginError(data.message || "This app has reached its user limit. Please contact support.");
            return;
          }
        } catch (err) {
          console.warn("User limit check unavailable:", err.message);
        }
      }

      const sb = SendbirdChat.init({ appId: APP_ID, modules: [new GroupChannelModule()] });
      sbRef.current = sb;
      await sb.connect(id);
      localStorage.setItem("sb_user_id", id);
      setUserId(id);
      setIsLoggedIn(true);

      const loadedChannels = await loadChannels(sb);
      const savedUrl = localStorage.getItem("sb_selected_channel");
      if (savedUrl && loadedChannels) {
        const restored = loadedChannels.find(c => c.url === savedUrl);
        if (restored) await selectChannel(restored);
      }

      const handler = new GroupChannelHandler();

      handler.onMessageReceived = (channel, message) => {
        if (selectedChannelRef.current?.url === channel.url) {
          setMessages(prev => prev.some(m => m.messageId === message.messageId)
            ? prev : [...prev, message]);
          channel.markAsRead();
        } else {
          setUnreadMap(prev => ({ ...prev, [channel.url]: (prev[channel.url] || 0) + 1 }));
        }
        // Move this channel to the top immediately — no round-trip needed
        setChannels(prev => [channel, ...prev.filter(c => c.url !== channel.url)]);
      };

      handler.onUserJoined = (channel, user) => {
        if (user.userId === id) loadChannels(sb);
      };

      handler.onChannelChanged = (channel) => {
        if (selectedChannelRef.current?.url === channel.url) setSelectedChannel(channel);
        // Move updated channel (e.g. agent replied) to top immediately
        setChannels(prev => [channel, ...prev.filter(c => c.url !== channel.url)]);
      };

      handler.onTypingStatusUpdated = (channel) => {
        if (selectedChannelRef.current?.url === channel.url)
          setTypingUsers(channel.getTypingUsers().map(u => u.userId));
      };

      sb.groupChannel.addGroupChannelHandler("GLOBAL_HANDLER", handler);
    } catch (err) {
      console.error("Login failed:", err);
      localStorage.removeItem("sb_user_id");
      localStorage.removeItem("sb_selected_channel");
    } finally {
      setIsConnecting(false);
      setIsAutoLogging(false);
    }
  };

  // ── Logout ───────────────────────────────────────────────────────────
  const logout = async () => {
    if (sbRef.current) {
      sbRef.current.groupChannel.removeGroupChannelHandler("GLOBAL_HANDLER");
      await sbRef.current.disconnect();
    }
    localStorage.removeItem("sb_user_id");
    localStorage.removeItem("sb_selected_channel");
    setIsLoggedIn(false); setUserId(""); setInputUserId("");
    setChannels([]); setSelectedChannel(null);
    setMessages([]); setText([]); setUnreadMap({});
  };

  // ── Load channels ────────────────────────────────────────────────────
  const loadChannels = async (sb) => {
    const query = (sb || sbRef.current).groupChannel.createMyGroupChannelListQuery({
      includeEmpty: true, limit: 50, order: "latest_last_message",
    });
    const list = await query.next();
    setChannels(list);
    return list;
  };

  // ── Create ticket ────────────────────────────────────────────────────
  const createNewTicket = async () => {
    if (isCreatingTicket) return;
    setIsCreatingTicket(true);
    try {
      const ch = await sbRef.current.groupChannel.createChannel({
        invitedUserIds: [BOT_ID], name: "New Support Ticket", isDistinct: false,
      });
      setChannels(prev => [ch, ...prev.filter(c => c.url !== ch.url)]);
      await selectChannel(ch);
    } catch (err) {
      console.error("Create ticket failed:", err);
      alert("Could not create a new ticket. Please check your connection and try again.");
    } finally {
      setIsCreatingTicket(false);
    }
  };

  // ── Select channel ───────────────────────────────────────────────────
  const selectChannel = async (channel) => {
    setFaqContent(null);
    setSelectedChannel(channel);
    localStorage.setItem("sb_selected_channel", channel.url);
    setTypingUsers([]);
    if (isMobile) setShowSidebarOnMobile(false);
    setUnreadMap(prev => ({ ...prev, [channel.url]: 0 }));
    channel.markAsRead();

    const history = await channel.getMessagesByTimestamp(Date.now(), {
      prevResultSize: 50, nextResultSize: 0, isInclusive: true,
    });
    setMessages(history);

    if (history.length === 0 && BACKEND_URL) {
      try {
        await fetch(`${BACKEND_URL}/welcome`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelUrl: channel.url, userId }),
        });
      } catch {}
    }
  };

  // ── Delete channel ───────────────────────────────────────────────────
  const deleteChannel = async (e, channel) => {
    e.stopPropagation();
    try {
      await channel.delete();
      setChannels(prev => prev.filter(c => c.url !== channel.url));
      if (selectedChannel?.url === channel.url) { setSelectedChannel(null); setMessages([]); }
    } catch (err) { console.error("Delete failed:", err); }
  };

  // ── Send message ─────────────────────────────────────────────────────
  const sendMessage = useCallback(() => {
    if (!text.trim() || !selectedChannel || isSending) return;
    const messageText = text;
    setText("");
    setIsSending(true);

    const req = selectedChannel.sendUserMessage({ message: messageText });
    req.onSucceeded(async (message) => {
      setMessages(prev => prev.some(m => m.messageId === message.messageId)
        ? prev : [...prev, message]);
      setIsSending(false);
      if (!selectedChannel.name || selectedChannel.name === "New Support Ticket") {
        const newTitle = messageText.length > 30 ? messageText.slice(0, 30) + "..." : messageText;
        await selectedChannel.updateChannel({ name: newTitle });
        loadChannels();
      }
    });
    req.onFailed((err) => { console.error("Send failed:", err); setIsSending(false); });
  }, [text, selectedChannel, isSending]);

  // ── Action button handler ────────────────────────────────────────────
  const handleButtonAction = useCallback(async (action, meta = {}) => {
    if (action === "retry_payment") {
      try {
        const res = await fetch(`${BACKEND_URL}/retry-payment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txnId: meta.txnId, channelUrl: selectedChannel?.url, userId }),
        });
        const data = await res.json();
        if (data.paymentUrl) window.location.href = data.paymentUrl;
        else alert(data.error || data.message || "Could not create payment link.");
      } catch { alert("Could not reach the payment service."); }

    } else if (action === "escalate") {
      const nowMs = Date.now();
      const optUser = { messageId: `opt_${nowMs}`,     sender: { userId }, message: "I need to speak to a human agent.", createdAt: nowMs };
      const optBot  = { messageId: `opt_${nowMs + 1}`, sender: { userId: BOT_ID }, message: "Connecting you with a human agent… please wait.", createdAt: nowMs + 1 };
      setMessages(prev => [...prev, optUser, optBot]);
      try {
        const res = await fetch(`${BACKEND_URL}/escalate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelUrl: selectedChannel?.url, userId }),
        });
        if (!res.ok) {
          setMessages(prev => prev.filter(m => m.messageId !== optUser.messageId && m.messageId !== optBot.messageId));
          const data = await res.json().catch(() => ({}));
          alert(data.error || "Could not connect to an agent. Please try again.");
          return;
        }
        const ch = selectedChannel;
        [3000, 7000, 15000].forEach(delay => setTimeout(async () => {
          if (!ch) return;
          const history = await ch.getMessagesByTimestamp(Date.now(), { prevResultSize: 50, nextResultSize: 0, isInclusive: true });
          setMessages(history);
        }, delay));
      } catch {
        setMessages(prev => prev.filter(m => m.messageId !== optUser.messageId && m.messageId !== optBot.messageId));
        alert("Could not reach support. Please try again.");
      }

    } else if (["refund_start","refund_reason","refund_accept_partial","refund_decline"].includes(action)) {
      const nowMs = Date.now();
      const optMsg = { messageId: `opt_refund_${nowMs}`, sender: { userId: BOT_ID }, message: "Processing your request…", createdAt: nowMs };
      setMessages(prev => [...prev, optMsg]);
      try {
        const res = await fetch(`${BACKEND_URL}/refund-action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelUrl: selectedChannel?.url, userId, txnId: meta.txnId, action, reason: meta.reason }),
        });
        if (!res.ok) {
          setMessages(prev => prev.filter(m => m.messageId !== optMsg.messageId));
          const data = await res.json().catch(() => ({}));
          alert(data.error || "Could not process refund action.");
          return;
        }
        const ch = selectedChannel;
        [2000, 5000, 10000, 15000].forEach(delay => setTimeout(async () => {
          if (!ch) return;
          const history = await ch.getMessagesByTimestamp(Date.now(), { prevResultSize: 50, nextResultSize: 0, isInclusive: true });
          setMessages(history);
        }, delay));
      } catch {
        setMessages(prev => prev.filter(m => m.messageId !== optMsg.messageId));
        alert("Could not reach the service. Please try again.");
      }

    } else if (["check_transaction","ask_refund","ask_retry"].includes(action)) {
      try {
        await fetch(`${BACKEND_URL}/transaction-list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelUrl: selectedChannel?.url, userId }),
        });
        const ch = selectedChannel;
        [2000, 5000].forEach(delay => setTimeout(async () => {
          if (!ch) return;
          const history = await ch.getMessagesByTimestamp(Date.now(), { prevResultSize: 50, nextResultSize: 0, isInclusive: true });
          setMessages(history);
        }, delay));
      } catch { console.error("Transaction list failed"); }

    } else if (action === "view_transaction") {
      const nowMs = Date.now();
      const optMsg = { messageId: `opt_view_${nowMs}`, sender: { userId: BOT_ID }, message: "Looking up transaction details…", createdAt: nowMs };
      setMessages(prev => [...prev, optMsg]);
      try {
        await fetch(`${BACKEND_URL}/view-transaction`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelUrl: selectedChannel?.url, userId, txnId: meta.txnId }),
        });
        const ch = selectedChannel;
        [2000, 5000, 10000].forEach(delay => setTimeout(async () => {
          if (!ch) return;
          const history = await ch.getMessagesByTimestamp(Date.now(), { prevResultSize: 50, nextResultSize: 0, isInclusive: true });
          setMessages(history);
        }, delay));
      } catch {
        setMessages(prev => prev.filter(m => m.messageId !== optMsg.messageId));
        alert("Could not fetch transaction details.");
      }

    } else if (action === "faq") {
      try {
        const res = await fetch(`${BACKEND_URL}/knowledge-base`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "payment failed" }),
        });
        const data = await res.json();
        setFaqContent(data.found ? data.answer : "Common payment failure reasons: insufficient funds, card declined, expired card, or network issues.");
      } catch {
        setFaqContent("Common payment failure reasons: insufficient funds, card declined, expired card, or network issues.");
      }
    }
  }, [selectedChannel, userId]);

  // ── Helpers ──────────────────────────────────────────────────────────
  const handleTyping = (e) => {
    setText(e.target.value);
    if (selectedChannel) selectedChannel.startTyping();
  };

  const formatTime = (ts) => ts
    ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  const getStatusPill = (msg) => {
    if (!msg) return null;
    const l = msg.toLowerCase();
    if (l.includes("escalat")) return { label: "Escalated", cls: "status-escalated" };
    if (l.includes("success") || l.includes("refund"))  return { label: "Resolved",  cls: "status-resolved" };
    if (l.includes("pending"))                           return { label: "Pending",   cls: "status-pending" };
    return null;
  };

  const filteredChannels = channels.filter(ch =>
    (ch.name || "Support Ticket").toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ── Reconnecting screen ───────────────────────────────────────────────
  if (isAutoLogging) return (
    <div className="reconnect-screen">
      <div className="reconnect-logo">💼</div>
      <div className="reconnect-text">Reconnecting to your session…</div>
    </div>
  );

  // ── Login / Landing page ─────────────────────────────────────────────
  if (!isLoggedIn) return (
    <div className="landing-root">
      {/* ── LEFT: Brand panel ── */}
      <div className="landing-left">
        <div className="landing-orb landing-orb-1" />
        <div className="landing-orb landing-orb-2" />
        <div className="landing-orb landing-orb-3" />

        <div className="landing-brand">
          <div className="landing-brand-icon">💼</div>
          <div>
            <div className="landing-brand-name">MySupp</div>
            <div className="landing-brand-tag">Fintech Support Platform</div>
          </div>
        </div>

        <h1 className="landing-headline">
          Smart support<br />
          <span>powered by AI</span>
        </h1>
        <p className="landing-sub">
          Resolve refunds, track payments, and connect with agents — all in one intelligent support platform.
        </p>

        <div className="landing-features">
          <div className="landing-feature">
            <div className="landing-feature-icon purple">⚡</div>
            <div className="landing-feature-text">
              <strong>Instant Refund Processing</strong>
              <span>AI-evaluated refunds processed in seconds</span>
            </div>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon blue">🔍</div>
            <div className="landing-feature-text">
              <strong>Real-Time Transaction Tracking</strong>
              <span>Monitor payments and status live</span>
            </div>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon green">🧑‍💼</div>
            <div className="landing-feature-text">
              <strong>Human Agent Escalation</strong>
              <span>Seamlessly connect to support agents</span>
            </div>
          </div>
          <div className="landing-feature">
            <div className="landing-feature-icon amber">🛡️</div>
            <div className="landing-feature-text">
              <strong>Fraud Detection</strong>
              <span>Deterministic rules protect every transaction</span>
            </div>
          </div>
        </div>

        <div className="landing-stats">
          <div>
            <div className="landing-stat-value">99.9%</div>
            <div className="landing-stat-label">Uptime</div>
          </div>
          <div>
            <div className="landing-stat-value">&lt; 2s</div>
            <div className="landing-stat-label">Avg. Response</div>
          </div>
          <div>
            <div className="landing-stat-value">24/7</div>
            <div className="landing-stat-label">AI Support</div>
          </div>
        </div>
      </div>

      {/* ── RIGHT: Login form ── */}
      <div className="landing-right">
        <div className="login-card">
          <h2 className="login-welcome">Welcome back 👋</h2>
          <p className="login-welcome-sub">Sign in to manage your support tickets</p>

          <label className="login-label">User ID</label>
          <div className="login-input-wrap">
            <span className="login-input-icon">🪪</span>
            <input
              className="login-input"
              placeholder="e.g. raol1234"
              value={inputUserId}
              onChange={(e) => { setInputUserId(e.target.value); setLoginError(""); }}
              onKeyDown={(e) => e.key === "Enter" && login()}
              autoComplete="username"
              autoFocus
            />
          </div>

          <div className="login-hint">
            💡 Use any ID to sign in. New users are <strong>registered automatically</strong>.
          </div>

          <button className="login-btn" onClick={login} disabled={isConnecting || !inputUserId.trim()}>
            {isConnecting ? (
              <><span className="login-btn-spinner" />Connecting…</>
            ) : "Sign In →"}
          </button>

          {loginError && (
            <div className="login-error">
              <span>⚠️</span> {loginError}
            </div>
          )}

          <div className="login-trust">
            <div className="login-trust-item">🔒 Secure</div>
            <div className="login-trust-item">⚡ Instant</div>
            <div className="login-trust-item">🆓 Free</div>
          </div>
        </div>
      </div>
    </div>
  );

  // ── Main App ──────────────────────────────────────────────────────────
  return (
    <div className="app-root">

      {/* ── SIDEBAR ── */}
      <div className="sidebar" style={{
        display: isMobile ? (showSidebarOnMobile ? "flex" : "none") : "flex",
        flexDirection: "column",
        width: isMobile ? "100%" : "300px",
      }}>
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <div className="sidebar-brand-icon">💼</div>
            <div className="sidebar-brand-name">MySupp</div>
          </div>
          <div className="sidebar-user">
            <div className="sidebar-avatar">{userId[0]?.toUpperCase()}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sidebar-user-name">{userId}</div>
              <div className="sidebar-user-status">Online</div>
            </div>
            <button className="sidebar-logout-btn" onClick={logout} title="Sign out">↩</button>
          </div>
        </div>

        <div className="sidebar-search">
          <input
            className="sidebar-search-input"
            placeholder="Search tickets…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <button className="sidebar-new-btn" onClick={createNewTicket} disabled={isCreatingTicket}>
          {isCreatingTicket ? "Creating…" : "+ New Support Ticket"}
        </button>

        <div className="sidebar-section-label">Your Tickets</div>

        <div className="sidebar-channel-list">
          {filteredChannels.length === 0 && (
            <div className="sidebar-empty">No tickets yet</div>
          )}
          {filteredChannels.map((ch) => {
            const isActive = selectedChannel?.url === ch.url;
            const unread   = unreadMap[ch.url] || 0;
            const lastMsg  = ch.lastMessage?.message || "";
            const pill     = getStatusPill(lastMsg);

            return (
              <div
                key={ch.url}
                className={`channel-item ${isActive ? "active" : ""}`}
                onClick={() => selectChannel(ch)}
              >
                <div className="channel-icon">🎫</div>
                <div className="channel-info">
                  <div style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                    <span className="channel-name" style={{ fontWeight: unread ? 700 : 500 }}>
                      {ch.name || "Support Ticket"}
                    </span>
                    {pill && <span className={`status-pill ${pill.cls}`}>{pill.label}</span>}
                  </div>
                  <div className="channel-last-msg">{lastMsg.slice(0, 38)}{lastMsg.length > 38 ? "…" : ""}</div>
                </div>
                <div className="channel-meta">
                  <span className="channel-time">{formatTime(ch.lastMessage?.createdAt)}</span>
                  {unread > 0 && <span className="channel-unread">{unread}</span>}
                  {!ch.url?.startsWith("sendbird_desk_") && (
                    <span className="channel-delete" onClick={(e) => deleteChannel(e, ch)} title="Delete">🗑</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── CHAT AREA ── */}
      <div className="chat-container" style={{
        display: isMobile ? (showSidebarOnMobile ? "none" : "flex") : "flex",
      }}>
        {!selectedChannel ? (
          <div className="empty-state">
            <div className="empty-state-icon">💬</div>
            <h3>No ticket selected</h3>
            <p>Select a ticket from the sidebar or create a new one</p>
            <button className="empty-state-btn" onClick={createNewTicket} disabled={isCreatingTicket}>
              {isCreatingTicket ? "Creating…" : "+ New Support Ticket"}
            </button>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="chat-header">
              {isMobile && (
                <button className="mobile-back" onClick={() => setShowSidebarOnMobile(true)}>←</button>
              )}
              <div className="chat-header-icon">🎫</div>
              <div>
                <div className="chat-header-name">{selectedChannel.name || "Support Ticket"}</div>
                <div className="chat-header-meta">{selectedChannel.memberCount} members</div>
              </div>
            </div>

            {/* Payment notice */}
            {paymentNotice && (
              <div className={`payment-notice ${paymentNotice.type === "success" ? "success" : "cancelled"}`}>
                <span>
                  {paymentNotice.type === "success"
                    ? `✅ Payment for ${paymentNotice.txnId} was successful!`
                    : `⚠️ Payment for ${paymentNotice.txnId} was cancelled. You can retry below.`}
                </span>
                <button className="payment-notice-close" onClick={() => setPaymentNotice(null)}>×</button>
              </div>
            )}

            {/* Messages */}
            <div className="chat-area">
              {messages.map((msg) => {
                if (!msg.message) return null;
                const isUser  = msg.sender?.userId === userId;
                const isBot   = msg.sender?.userId === BOT_ID;
                const rowCls  = isUser ? "user" : isBot ? "bot" : "agent";

                // Parse message.data for rich UI elements
                let msgData = null;
                if (!isUser && msg.data) {
                  try { msgData = JSON.parse(msg.data); } catch {}
                }

                return (
                  <div key={msg.messageId} className={`msg-row ${rowCls}`} style={{ marginBottom: "10px" }}>
                    {!isUser && (
                      <div className="msg-avatar" style={{ background: isBot ? "linear-gradient(135deg,#6366f1,#8b5cf6)" : "linear-gradient(135deg,#0f172a,#1e293b)" }}>
                        {isBot ? "🤖" : msg.sender?.userId?.[0]?.toUpperCase()}
                      </div>
                    )}
                    <div className="msg-body" style={{ maxWidth: isMobile ? "85%" : "65%" }}>
                      {!isUser && (
                        <div className="msg-sender">{isBot ? "Support Bot" : msg.sender?.userId}</div>
                      )}
                      <div className={`msg-bubble ${rowCls}`}>{msg.message}</div>

                      {/* ── Rich data rendering ── */}
                      {msgData?.type === "action_buttons" && msgData.buttons?.length > 0 && (
                        <div className="action-btns">
                          {msgData.buttons.map((btn) => (
                            <button
                              key={btn.action + (btn.reason || "")}
                              className={`action-btn ${btn.reason === "fraud" ? "danger" : ""}`}
                              onClick={() => handleButtonAction(btn.action, {
                                txnId: btn.txnId || msgData.txnId,
                                reason: btn.reason,
                              })}
                            >
                              {btn.label}
                            </button>
                          ))}
                        </div>
                      )}

                      {msgData?.type === "priority_badge" && (
                        <div className={`priority-badge ${msgData.priority === "HIGH" ? "high" : "escalated"}`}>
                          {msgData.priority === "HIGH" ? "🚨 HIGH PRIORITY" : "⚠️ ESCALATED"}
                        </div>
                      )}

                      {msgData?.type === "refund_status" && (() => {
                        const map = {
                          refunded:      { cls: "refunded", label: `✅ Refund Processed${msgData.amount ? ` · $${Number(msgData.amount).toFixed(2)}` : ""}` },
                          coupon_issued: { cls: "coupon",   label: `🎟 Coupon Issued${msgData.couponCode ? ` · ${msgData.couponCode}` : ""}` },
                        };
                        const cfg = map[msgData.status];
                        return cfg ? <div className={`refund-badge ${cfg.cls}`}>{cfg.label}</div> : null;
                      })()}

                      <div className="msg-time">{formatTime(msg.createdAt)}</div>
                    </div>
                  </div>
                );
              })}

              {typingUsers.length > 0 && (
                <div className="typing-row">
                  <div className="msg-avatar">🤖</div>
                  <div className="typing-bubble">
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                  </div>
                </div>
              )}

              <div ref={bottomRef} />
            </div>

            {/* FAQ panel */}
            {faqContent && (
              <div className="faq-panel">
                <div className="faq-panel-header">
                  <span className="faq-panel-label">📖 FAQ</span>
                  <button className="faq-close" onClick={() => setFaqContent(null)}>×</button>
                </div>
                <div className="faq-body">{faqContent}</div>
              </div>
            )}

            {/* Input */}
            <div className="input-area">
              <input
                className="message-input"
                value={text}
                onChange={handleTyping}
                placeholder="Type a message or transaction ID (e.g. TXN1001)…"
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              />
              <button
                className="send-btn"
                onClick={sendMessage}
                disabled={isSending || !text.trim()}
                title="Send"
              >
                {isSending ? "…" : "➤"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
