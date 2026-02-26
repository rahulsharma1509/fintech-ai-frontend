import { useEffect, useState, useRef, useCallback } from "react";
import SendbirdChat from "@sendbird/chat";
import { GroupChannelModule, GroupChannelHandler } from "@sendbird/chat/groupChannel";

const APP_ID = process.env.REACT_APP_SENDBIRD_APP_ID;
const BOT_ID = process.env.REACT_APP_BOT_ID || "support_bot";
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "https://fintech-ai-backend-r8ap.onrender.com";

function App() {
  const [userId, setUserId] = useState("");
  const [inputUserId, setInputUserId] = useState("");
  const [channels, setChannels] = useState([]);
  const [selectedChannel, setSelectedChannel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isAutoLogging, setIsAutoLogging] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [typingUsers, setTypingUsers] = useState([]);
  const [unreadMap, setUnreadMap] = useState({});
  const [searchQuery, setSearchQuery] = useState("");
  const [loginError, setLoginError] = useState("");
  const [faqContent, setFaqContent] = useState(null);       // inline FAQ panel text
  const [paymentNotice, setPaymentNotice] = useState(null); // { type, txnId } after Stripe redirect

  const sbRef = useRef(null);
  const selectedChannelRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    selectedChannelRef.current = selectedChannel;
  }, [selectedChannel]);

  // =========================
  // AUTO LOGIN ON REFRESH
  // =========================
  useEffect(() => {
    const savedUserId = localStorage.getItem("sb_user_id");
    if (savedUserId) {
      setInputUserId(savedUserId);
      loginWithId(savedUserId);
    } else {
      setIsAutoLogging(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // =========================
  // STRIPE REDIRECT DETECTION
  // After Stripe redirects back, read ?payment=success|cancelled&txn=TXN1001
  // from the URL, store it in state, then clean the URL bar.
  // =========================
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get("payment");
    const txn = params.get("txn");
    if (payment && txn) {
      setPaymentNotice({ type: payment, txnId: txn });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // =========================
  // LOGIN
  // =========================
  const login = async () => {
    if (!inputUserId.trim()) return;
    await loginWithId(inputUserId);
  };

  const loginWithId = async (id) => {
    setIsConnecting(true);
    setLoginError("");
    try {
      // Enforce 20-user hard limit via backend.
      // Only a deliberate 403 (limit reached) blocks login.
      // 404 (old backend), 500, or network errors all let login proceed.
      if (BACKEND_URL) {
        try {
          const res = await fetch(`${BACKEND_URL}/register-user`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: id }),
          });
          if (res.status === 403) {
            try {
              const data = await res.json();
              setLoginError(data.message || "Access denied. Please contact support.");
            } catch {
              setLoginError("This app has reached its user limit. Please contact support.");
            }
            return;
          }
          // 200, 201, 404 (old backend), 500 → all proceed with login
        } catch (err) {
          console.warn("User limit check unavailable, proceeding:", err.message);
        }
      }

      const sb = SendbirdChat.init({
        appId: APP_ID,
        modules: [new GroupChannelModule()],
      });

      sbRef.current = sb;
      await sb.connect(id);
      localStorage.setItem("sb_user_id", id);
      setUserId(id);
      setIsLoggedIn(true);
      const loadedChannels = await loadChannels(sb);

      // ✅ Restore last selected channel after refresh
      const savedChannelUrl = localStorage.getItem("sb_selected_channel");
      if (savedChannelUrl && loadedChannels) {
        const restored = loadedChannels.find(c => c.url === savedChannelUrl);
        if (restored) await selectChannel(restored);
      }

      const handler = new GroupChannelHandler();
      handler.onMessageReceived = (channel, message) => {
        const current = selectedChannelRef.current;
        if (current && channel.url === current.url) {
          setMessages(prev => {
            if (prev.some(m => m.messageId === message.messageId)) return prev;
            return [...prev, message];
          });
          channel.markAsRead();
        } else {
          setUnreadMap(prev => ({
            ...prev,
            [channel.url]: (prev[channel.url] || 0) + 1
          }));
        }
        loadChannels(sb);
      };

      // ✅ Detect when current user is added to a new channel (e.g. Desk channels via Platform API)
      handler.onUserJoined = (channel, user) => {
        if (user.userId === id) {
          console.log("📨 Added to new channel:", channel.url);
          loadChannels(sb);
        }
      };

      // ✅ Listen for channel updates
      handler.onChannelChanged = (channel) => {
        const current = selectedChannelRef.current;
        if (current && channel.url === current.url) {
          setSelectedChannel(channel);
        }
        loadChannels(sb);
      };

      handler.onTypingStatusUpdated = (channel) => {
        if (selectedChannelRef.current?.url === channel.url) {
          const typers = channel.getTypingUsers();
          setTypingUsers(typers.map(u => u.userId));
        }
      };

      sb.groupChannel.addGroupChannelHandler("GLOBAL_HANDLER", handler);
    } catch (err) {
      console.error("Login failed:", err);
      localStorage.removeItem("sb_user_id");
    localStorage.removeItem("sb_selected_channel"); // ✅ Clear selected channel on logout
    } finally {
      setIsConnecting(false);
      setIsAutoLogging(false);
    }
  };

  // =========================
  // LOGOUT
  // =========================
  const logout = async () => {
    if (sbRef.current) {
      sbRef.current.groupChannel.removeGroupChannelHandler("GLOBAL_HANDLER");
      await sbRef.current.disconnect();
    }
    localStorage.removeItem("sb_user_id");
    localStorage.removeItem("sb_selected_channel");
    setIsLoggedIn(false);
    setUserId("");
    setInputUserId("");
    setChannels([]);
    setSelectedChannel(null);
    setMessages([]);
    setText("");
    setUnreadMap({});
  };

  // =========================
  // LOAD CHANNELS
  // =========================
  const loadChannels = async (sb) => {
    const query = (sb || sbRef.current).groupChannel.createMyGroupChannelListQuery({
      includeEmpty: true,
      limit: 50, // ✅ Increased to include Desk channels
      order: "latest_last_message",
    });
    const channelList = await query.next();
    setChannels(channelList);
    return channelList; // ✅ Return for use in auto-restore
  };

  // =========================
  // CREATE NEW TICKET
  // =========================
  const createNewTicket = async () => {
    const ch = await sbRef.current.groupChannel.createChannel({
      invitedUserIds: [BOT_ID],
      name: "New Support Ticket",
      isDistinct: false,
    });
    setChannels(prev => [ch, ...prev]);
    selectChannel(ch);
  };

  // =========================
  // SELECT CHANNEL
  // =========================
  const selectChannel = async (channel) => {
    setFaqContent(null);
    setSelectedChannel(channel);
    localStorage.setItem("sb_selected_channel", channel.url); // ✅ Persist selected channel
    setTypingUsers([]);
    setUnreadMap(prev => ({ ...prev, [channel.url]: 0 }));
    channel.markAsRead();
    const history = await channel.getMessagesByTimestamp(Date.now(), {
      prevResultSize: 50,
      nextResultSize: 0,
      isInclusive: true,
    });
    setMessages(history);
  };

  // =========================
  // DELETE CHANNEL
  // =========================
  const deleteChannel = async (e, channel) => {
    e.stopPropagation();
    try {
      await channel.delete();
      setChannels(prev => prev.filter(c => c.url !== channel.url));
      if (selectedChannel?.url === channel.url) {
        setSelectedChannel(null);
        setMessages([]);
      }
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  // =========================
  // SEND MESSAGE
  // =========================
  const sendMessage = useCallback(() => {
    if (!text.trim() || !selectedChannel || isSending) return;
    const messageText = text;
    setText("");
    setIsSending(true);

    const request = selectedChannel.sendUserMessage({ message: messageText });

    request.onSucceeded(async (message) => {
      setMessages(prev => {
        if (prev.some(m => m.messageId === message.messageId)) return prev;
        return [...prev, message];
      });
      setIsSending(false);

      if (!selectedChannel.name || selectedChannel.name === "New Support Ticket") {
        const newTitle = messageText.length > 30
          ? messageText.substring(0, 30) + "..."
          : messageText;
        await selectedChannel.updateChannel({ name: newTitle });
        loadChannels();
      }
    });

    request.onFailed((error) => {
      console.error("Send failed:", error);
      setIsSending(false);
    });
  }, [text, selectedChannel, isSending]);

  // =========================
  // ACTION BUTTON HANDLER
  // Called when the user clicks one of the interactive buttons embedded in a
  // bot message (Retry Payment / Talk to Human / View FAQ).
  // =========================
  const handleButtonAction = useCallback(async (action, meta = {}) => {
    if (action === "retry_payment") {
      try {
        const res = await fetch(`${BACKEND_URL}/retry-payment`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ txnId: meta.txnId, channelUrl: selectedChannel?.url, userId }),
        });
        const data = await res.json();
        if (data.paymentUrl) {
          window.open(data.paymentUrl, "_blank");
        } else {
          alert(data.error || data.message || "Could not create payment link. Please try again.");
        }
      } catch (err) {
        console.error("Retry payment failed:", err);
        alert("Could not reach the payment service. Please try again.");
      }

    } else if (action === "escalate") {
      // Call /escalate directly — creates a Desk ticket immediately without
      // relying on the webhook intent detection chain.
      try {
        const res = await fetch(`${BACKEND_URL}/escalate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channelUrl: selectedChannel?.url, userId }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert(data.error || "Could not connect to an agent. Please try again.");
        }
      } catch (err) {
        console.error("Escalation failed:", err);
        alert("Could not reach support. Please try again.");
      }

    } else if (action === "faq") {
      // Query the KB for payment failure FAQ, then show the answer inline
      // below the chat — no new Sendbird message needed.
      if (!BACKEND_URL) {
        setFaqContent(
          "Common payment failure reasons: insufficient funds, card declined, expired card, or network issues. Contact support for help."
        );
        return;
      }
      try {
        const res = await fetch(`${BACKEND_URL}/knowledge-base`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "payment failed" }),
        });
        const data = await res.json();
        setFaqContent(
          data.found
            ? data.answer
            : "Common payment failure reasons: insufficient funds, card declined, expired card, or network issues. Contact support for further assistance."
        );
      } catch {
        setFaqContent(
          "Common payment failure reasons: insufficient funds, card declined, expired card, or network issues."
        );
      }
    }
  }, [selectedChannel, userId]);

  // =========================
  // TYPING INDICATOR
  // =========================
  const handleTyping = (e) => {
    setText(e.target.value);
    if (selectedChannel) selectedChannel.startTyping();
  };

  // =========================
  // AUTO SCROLL
  // =========================
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // =========================
  // FILTER CHANNELS
  // =========================
  const filteredChannels = channels.filter(ch =>
    (ch.name || "Support Ticket").toLowerCase().includes(searchQuery.toLowerCase())
  );

  // =========================
  // GET STATUS BADGE
  // =========================
  const getStatusBadge = (msg) => {
    if (!msg) return null;
    const lower = msg.toLowerCase();
    if (lower.includes("failed") || lower.includes("escalating")) return { label: "Escalated", color: "#e74c3c" };
    if (lower.includes("success")) return { label: "Resolved", color: "#27ae60" };
    if (lower.includes("pending")) return { label: "Pending", color: "#f39c12" };
    return null;
  };

  // =========================
  // FORMAT TIME
  // =========================
  const formatTime = (ts) => {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  // =========================
  // RECONNECTING SCREEN
  // =========================
  if (isAutoLogging) {
    return (
      <div style={styles.loginWrapper}>
        <div style={{ textAlign: "center", color: "#fff" }}>
          <div style={{ fontSize: "40px", marginBottom: "16px" }}>💼</div>
          <div style={{ fontSize: "16px" }}>Reconnecting...</div>
        </div>
      </div>
    );
  }

  // =========================
  // LOGIN SCREEN
  // =========================
  if (!isLoggedIn) {
    return (
      <div style={styles.loginWrapper}>
        <div style={styles.loginCard}>
          <div style={styles.logo}>💼</div>
          <h2 style={{ margin: "0 0 6px", fontSize: "22px" }}>Support Portal</h2>
          <p style={{ color: "#888", margin: "0 0 24px", fontSize: "14px" }}>Sign in to manage your support tickets</p>
          <input
            placeholder="Enter your user ID"
            value={inputUserId}
            onChange={(e) => { setInputUserId(e.target.value); setLoginError(""); }}
            onKeyDown={(e) => e.key === "Enter" && login()}
            style={styles.loginInput}
          />
          <button onClick={login} style={styles.loginButton} disabled={isConnecting}>
            {isConnecting ? "Connecting..." : "Sign In"}
          </button>
          {loginError && (
            <div style={{ marginTop: "12px", padding: "10px 14px", background: "#fff0f0", border: "1px solid #f5c6cb", borderRadius: "8px", color: "#c0392b", fontSize: "13px", textAlign: "left" }}>
              {loginError}
            </div>
          )}
        </div>
      </div>
    );
  }

  // =========================
  // MAIN UI
  // =========================
  return (
    <div style={styles.container}>
      {/* SIDEBAR */}
      <div style={styles.sidebar}>
        <div style={styles.userInfo}>
          <div style={styles.avatar}>{userId[0]?.toUpperCase()}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: "600", fontSize: "14px" }}>{userId}</div>
            <div style={{ fontSize: "11px", color: "#27ae60" }}>● Online</div>
          </div>
          <button onClick={logout} style={styles.logoutBtn} title="Logout">↩</button>
        </div>

        <div style={styles.searchWrapper}>
          <input
            placeholder="🔍 Search tickets..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={styles.searchInput}
          />
        </div>

        <button onClick={createNewTicket} style={styles.newButton}>
          + New Support Ticket
        </button>

        <div style={styles.channelList}>
          {filteredChannels.length === 0 && (
            <div style={{ padding: "20px", textAlign: "center", color: "#aaa", fontSize: "13px" }}>
              No tickets found
            </div>
          )}
          {filteredChannels.map((ch) => {
            const isSelected = selectedChannel?.url === ch.url;
            const unread = unreadMap[ch.url] || 0;
            const lastMsg = ch.lastMessage?.message || "";
            const badge = getStatusBadge(lastMsg);

            return (
              <div
                key={ch.url}
                onClick={() => selectChannel(ch)}
                style={{
                  ...styles.channelItem,
                  background: isSelected ? "#e8f0fe" : "transparent",
                  borderLeft: isSelected ? "3px solid #1e2a38" : "3px solid transparent",
                }}
              >
                <div style={styles.channelIcon}>🎫</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: unread ? "700" : "500", fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {ch.name || "Support Ticket"}
                    </span>
                    <span style={{ fontSize: "10px", color: "#aaa", marginLeft: "4px", whiteSpace: "nowrap" }}>
                      {formatTime(ch.lastMessage?.createdAt)}
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "2px" }}>
                    {badge && (
                      <span style={{ fontSize: "9px", background: badge.color, color: "#fff", padding: "1px 5px", borderRadius: "4px" }}>
                        {badge.label}
                      </span>
                    )}
                    <span style={{ fontSize: "11px", color: "#888", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {lastMsg.substring(0, 35)}{lastMsg.length > 35 ? "..." : ""}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", marginLeft: "4px" }}>
                  {unread > 0 && (
                    <span style={styles.unreadBadge}>{unread}</span>
                  )}
                  {!ch.url?.startsWith("sendbird_desk_") && (
                    <span
                      style={styles.deleteIcon}
                      onClick={(e) => deleteChannel(e, ch)}
                      title="Delete ticket"
                    >🗑</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* CHAT WINDOW */}
      <div style={styles.chatContainer}>
        {!selectedChannel ? (
          <div style={styles.emptyState}>
            <div style={{ fontSize: "48px" }}>💬</div>
            <h3>Select a ticket to start chatting</h3>
            <p style={{ color: "#aaa", fontSize: "14px" }}>Or create a new support ticket</p>
            <button onClick={createNewTicket} style={{ ...styles.loginButton, marginTop: "16px", width: "auto", padding: "10px 24px" }}>
              + New Ticket
            </button>
          </div>
        ) : (
          <>
            <div style={styles.chatHeader}>
              <div style={styles.channelIcon}>🎫</div>
              <div>
                <div style={{ fontWeight: "600" }}>{selectedChannel.name || "Support Ticket"}</div>
                <div style={{ fontSize: "11px", color: "#aaa" }}>{selectedChannel.memberCount} members</div>
              </div>
            </div>

            {/* Payment redirect notice — shown after Stripe redirects back */}
            {paymentNotice && (
              <div style={{
                padding: "10px 16px",
                background: paymentNotice.type === "success" ? "#e8f8e8" : "#fff8e8",
                borderBottom: `1px solid ${paymentNotice.type === "success" ? "#a8dca8" : "#ffd08a"}`,
                fontSize: "13px",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}>
                <span style={{ color: paymentNotice.type === "success" ? "#27ae60" : "#e67e22", fontWeight: "500" }}>
                  {paymentNotice.type === "success"
                    ? `Payment for ${paymentNotice.txnId} was successful!`
                    : `Payment for ${paymentNotice.txnId} was cancelled. You can retry below.`}
                </span>
                <button onClick={() => setPaymentNotice(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", fontSize: "18px", lineHeight: 1, padding: 0 }}>×</button>
              </div>
            )}

            <div style={styles.chatArea}>
              {messages.map((msg) => {
                if (!msg.message) return null;
                const isUser = msg.sender?.userId === userId;
                const isBot = msg.sender?.userId === BOT_ID;

                return (
                  <div
                    key={msg.messageId}
                    style={{
                      display: "flex",
                      justifyContent: isUser ? "flex-end" : "flex-start",
                      marginBottom: "12px",
                      alignItems: "flex-end",
                      gap: "8px",
                    }}
                  >
                    {!isUser && (
                      <div style={{ ...styles.avatar, width: "28px", height: "28px", fontSize: "12px", flexShrink: 0 }}>
                        {isBot ? "🤖" : msg.sender?.userId?.[0]?.toUpperCase()}
                      </div>
                    )}
                    <div style={{ maxWidth: "65%" }}>
                      {!isUser && (
                        <div style={{ fontSize: "10px", color: "#aaa", marginBottom: "3px", paddingLeft: "4px" }}>
                          {isBot ? "Support Bot" : msg.sender?.userId}
                        </div>
                      )}
                      <div style={{
                        background: isUser ? "#1e2a38" : isBot ? "#f0f4ff" : "#e9eef3",
                        color: isUser ? "#fff" : "#000",
                        padding: "10px 14px",
                        borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                        fontSize: "14px",
                        lineHeight: "1.4",
                        border: isBot ? "1px solid #d0dcff" : "none",
                      }}>
                        {msg.message}
                      </div>
                      {/* Action buttons — rendered for any incoming (non-user) message
                          that carries a data payload with type:"action_buttons".
                          Uses !isUser instead of isBot so agent messages with buttons
                          also render correctly and BOT_ID mismatches can't silently break this. */}
                      {!isUser && (() => {
                        if (!msg.data) return null;
                        let msgData = null;
                        try { msgData = JSON.parse(msg.data); } catch { return null; }
                        if (msgData?.type !== "action_buttons" || !msgData.buttons?.length) return null;
                        return (
                          <div style={{ display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" }}>
                            {msgData.buttons.map((btn) => (
                              <button
                                key={btn.action}
                                onClick={() => handleButtonAction(btn.action, { txnId: btn.txnId || msgData.txnId })}
                                style={{ padding: "6px 14px", borderRadius: "16px", border: "1px solid #1e2a38", background: "#fff", color: "#1e2a38", fontSize: "12px", cursor: "pointer", fontWeight: "500" }}
                              >
                                {btn.label}
                              </button>
                            ))}
                          </div>
                        );
                      })()}
                      <div style={{ fontSize: "10px", color: "#bbb", marginTop: "3px", textAlign: isUser ? "right" : "left", paddingLeft: "4px" }}>
                        {formatTime(msg.createdAt)}
                      </div>
                    </div>
                  </div>
                );
              })}

              {typingUsers.length > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                  <div style={{ ...styles.avatar, width: "28px", height: "28px", fontSize: "12px" }}>🤖</div>
                  <div style={{ background: "#f0f4ff", padding: "10px 14px", borderRadius: "18px 18px 18px 4px", border: "1px solid #d0dcff" }}>
                    <span style={styles.typingDot} />
                    <span style={{ ...styles.typingDot, animationDelay: "0.2s" }} />
                    <span style={{ ...styles.typingDot, animationDelay: "0.4s" }} />
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Inline FAQ panel — shown when user clicks "View FAQ" button */}
            {faqContent && (
              <div style={{ padding: "12px 16px", background: "#f0f4ff", borderTop: "1px solid #d0dcff", fontSize: "13px", color: "#333" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
                  <strong style={{ fontSize: "11px", color: "#555", textTransform: "uppercase", letterSpacing: "0.5px" }}>FAQ</strong>
                  <button onClick={() => setFaqContent(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", fontSize: "18px", lineHeight: 1, padding: 0 }}>×</button>
                </div>
                <div style={{ lineHeight: "1.6" }}>{faqContent}</div>
              </div>
            )}

            <div style={styles.inputArea}>
              <input
                style={styles.messageInput}
                value={text}
                onChange={handleTyping}
                placeholder="Type your message or transaction ID (e.g. TXN1001)..."
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              />
              <button
                style={{ ...styles.sendButton, opacity: isSending || !text.trim() ? 0.5 : 1 }}
                onClick={sendMessage}
                disabled={isSending || !text.trim()}
              >
                {isSending ? "..." : "➤"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: { display: "flex", height: "100vh", fontFamily: "'Inter', Arial, sans-serif", background: "#f4f6f8" },
  sidebar: { width: "300px", borderRight: "1px solid #e0e4e8", display: "flex", flexDirection: "column", background: "#fff" },
  userInfo: { display: "flex", alignItems: "center", gap: "10px", padding: "16px", borderBottom: "1px solid #f0f0f0" },
  avatar: { width: "36px", height: "36px", borderRadius: "50%", background: "#1e2a38", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: "bold", fontSize: "14px", flexShrink: 0 },
  logoutBtn: { background: "none", border: "1px solid #ddd", borderRadius: "6px", padding: "4px 8px", cursor: "pointer", fontSize: "14px" },
  searchWrapper: { padding: "10px 12px" },
  searchInput: { width: "100%", padding: "8px 12px", borderRadius: "20px", border: "1px solid #e0e4e8", fontSize: "13px", background: "#f8f9fb", boxSizing: "border-box" },
  newButton: { margin: "0 12px 10px", padding: "10px", borderRadius: "8px", border: "none", background: "#1e2a38", color: "#fff", cursor: "pointer", fontWeight: "600", fontSize: "13px" },
  channelList: { flex: 1, overflowY: "auto" },
  channelItem: { display: "flex", alignItems: "center", padding: "10px 12px", cursor: "pointer", gap: "8px", transition: "background 0.15s" },
  channelIcon: { fontSize: "16px", flexShrink: 0 },
  unreadBadge: { background: "#e74c3c", color: "#fff", borderRadius: "10px", padding: "1px 6px", fontSize: "10px", fontWeight: "bold" },
  deleteIcon: { cursor: "pointer", fontSize: "13px", opacity: 0.5 },
  chatContainer: { flex: 1, display: "flex", flexDirection: "column" },
  emptyState: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#555" },
  chatHeader: { padding: "14px 20px", borderBottom: "1px solid #e0e4e8", display: "flex", alignItems: "center", gap: "10px", background: "#fff" },
  chatArea: { flex: 1, padding: "20px", overflowY: "auto", background: "#f4f6f8" },
  inputArea: { display: "flex", padding: "12px 16px", borderTop: "1px solid #e0e4e8", background: "#fff", gap: "8px", alignItems: "center" },
  messageInput: { flex: 1, padding: "10px 16px", borderRadius: "24px", border: "1px solid #e0e4e8", fontSize: "14px", outline: "none" },
  sendButton: { width: "40px", height: "40px", borderRadius: "50%", border: "none", background: "#1e2a38", color: "#fff", cursor: "pointer", fontSize: "16px", display: "flex", alignItems: "center", justifyContent: "center" },
  typingDot: { display: "inline-block", width: "6px", height: "6px", borderRadius: "50%", background: "#888", margin: "0 2px", animation: "bounce 0.8s infinite" },
  loginWrapper: { height: "100vh", display: "flex", justifyContent: "center", alignItems: "center", background: "linear-gradient(135deg, #1e2a38 0%, #2c3e50 100%)" },
  loginCard: { width: "380px", padding: "48px 40px", background: "white", borderRadius: "16px", boxShadow: "0 20px 60px rgba(0,0,0,0.2)", textAlign: "center" },
  logo: { fontSize: "40px", marginBottom: "16px" },
  loginInput: { width: "100%", padding: "12px 16px", borderRadius: "8px", border: "1px solid #e0e4e8", fontSize: "14px", marginBottom: "16px", boxSizing: "border-box" },
  loginButton: { width: "100%", padding: "12px", borderRadius: "8px", border: "none", background: "#1e2a38", color: "white", fontSize: "15px", fontWeight: "600", cursor: "pointer" },
};

export default App;