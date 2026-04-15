import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { api, SOCKET_URL } from "./api";

const DEFAULT_ROOMS = [{ name: "general", userCount: 0, lastMessage: null }];
const SESSION_STORAGE_KEY = "chat:user";

function loadStoredSession() {
  try {
    const storedSession = JSON.parse(
      localStorage.getItem(SESSION_STORAGE_KEY) ?? "null"
    );

    if (storedSession?.id && storedSession?.username) {
      return storedSession;
    }
  } catch {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  }

  return null;
}

function loadStoredName() {
  const storedSession = loadStoredSession();

  if (storedSession?.username) {
    return storedSession.username;
  }

  return localStorage.getItem("chat:name") ?? "";
}

function formatTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function App() {
  const [session, setSession] = useState(loadStoredSession);
  const [loginName, setLoginName] = useState(loadStoredName);
  const [loginLoading, setLoginLoading] = useState(false);
  const [activeRoom, setActiveRoom] = useState("general");
  const [roomInput, setRoomInput] = useState("general");
  const [chatMode, setChatMode] = useState("room");
  const [rooms, setRooms] = useState(DEFAULT_ROOMS);
  const [messages, setMessages] = useState([]);
  const [users, setUsers] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [activePrivateUser, setActivePrivateUser] = useState(null);
  const [privateMessagesByUser, setPrivateMessagesByUser] = useState({});
  const [privateUnreadCounts, setPrivateUnreadCounts] = useState({});
  const [messageText, setMessageText] = useState("");
  const [privateMessageText, setPrivateMessageText] = useState("");
  const [typingUsers, setTypingUsers] = useState([]);
  const [status, setStatus] = useState("offline");
  const [error, setError] = useState("");

  const socketRef = useRef(null);
  const activeRoomRef = useRef(activeRoom);
  const activePrivateUserRef = useRef(activePrivateUser);
  const chatModeRef = useRef(chatMode);
  const sessionRef = useRef(session);
  const typingTimerRef = useRef(null);

  useEffect(() => {
    activeRoomRef.current = activeRoom;
  }, [activeRoom]);

  useEffect(() => {
    activePrivateUserRef.current = activePrivateUser;
  }, [activePrivateUser]);

  useEffect(() => {
    chatModeRef.current = chatMode;
  }, [chatMode]);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    api
      .get("/api/rooms")
      .then((response) => {
        setRooms(response.data.rooms ?? DEFAULT_ROOMS);
      })
      .catch(() => {
        setError("Backend API is not reachable yet.");
      });
  }, []);

  useEffect(() => {
    if (!session) {
      return undefined;
    }

    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"]
    });

    socketRef.current = socket;

    const joinCurrentRoom = () => {
      const currentSession = sessionRef.current;

      if (!currentSession) {
        return;
      }

      socket.emit(
        "room:join",
        {
          room: activeRoomRef.current,
          userId: currentSession.id,
          username: currentSession.username
        },
        (response) => {
          if (!response?.ok) {
            setError(response?.error ?? "Unable to join room.");
          }
        }
      );
    };

    socket.on("connect", () => {
      setStatus("connected");
      setError("");
      joinCurrentRoom();
    });

    socket.on("connect_error", () => {
      setStatus("offline");
      setError("Socket connection failed. Check that the backend is running.");
    });

    socket.on("disconnect", () => {
      setStatus("offline");
    });

    socket.on("rooms:update", (payload) => {
      setRooms(payload.rooms ?? DEFAULT_ROOMS);
    });

    socket.on("online:users", (payload) => {
      const nextUsers = payload.users ?? [];

      setOnlineUsers(nextUsers);
      setActivePrivateUser((currentUser) => {
        if (!currentUser) {
          return currentUser;
        }

        return nextUsers.find((user) => user.id === currentUser.id) ?? currentUser;
      });
    });

    socket.on("room:joined", (payload) => {
      setActiveRoom(payload.room);
      setRoomInput(payload.room);
      setMessages(payload.messages ?? []);
      setUsers(payload.users ?? []);
      setTypingUsers([]);
    });

    socket.on("room:users", (payload) => {
      setUsers(payload.users ?? []);
    });

    socket.on("chat:message", (message) => {
      setMessages((currentMessages) => {
        if (currentMessages.some((item) => item.id === message.id)) {
          return currentMessages;
        }

        return [...currentMessages, message].slice(-100);
      });
    });

    socket.on("private:message", (message) => {
      const currentSession = sessionRef.current;

      if (!currentSession) {
        return;
      }

      const isOwnPrivateMessage = message.fromUserId === currentSession.id;
      const peerId = isOwnPrivateMessage ? message.toUserId : message.fromUserId;

      setPrivateMessagesByUser((currentMessagesByUser) => {
        const currentMessages = currentMessagesByUser[peerId] ?? [];

        if (currentMessages.some((item) => item.id === message.id)) {
          return currentMessagesByUser;
        }

        return {
          ...currentMessagesByUser,
          [peerId]: [...currentMessages, message].slice(-100)
        };
      });

      if (
        !isOwnPrivateMessage &&
        !(
          chatModeRef.current === "private" &&
          activePrivateUserRef.current?.id === peerId
        )
      ) {
        setPrivateUnreadCounts((currentCounts) => ({
          ...currentCounts,
          [peerId]: (currentCounts[peerId] ?? 0) + 1
        }));
      }
    });

    socket.on("typing:update", (payload) => {
      const currentSession = sessionRef.current;

      if (!payload?.username || payload.userId === currentSession?.id) {
        return;
      }

      if (!payload.userId && payload.username === currentSession?.username) {
        return;
      }

      setTypingUsers((currentUsers) => {
        const nextUsers = new Set(currentUsers);

        if (payload.isTyping) {
          nextUsers.add(payload.username);
        } else {
          nextUsers.delete(payload.username);
        }

        return Array.from(nextUsers);
      });

      if (payload.isTyping) {
        window.setTimeout(() => {
          setTypingUsers((currentUsers) =>
            currentUsers.filter((name) => name !== payload.username)
          );
        }, 2500);
      }
    });

    return () => {
      window.clearTimeout(typingTimerRef.current);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [session]);

  const sortedRooms = useMemo(() => {
    return [...rooms].sort((first, second) => {
      if (first.name === activeRoom) {
        return -1;
      }

      if (second.name === activeRoom) {
        return 1;
      }

      return first.name.localeCompare(second.name);
    });
  }, [activeRoom, rooms]);

  const directUsers = useMemo(() => {
    return onlineUsers.filter((user) => user.id !== session?.id);
  }, [onlineUsers, session]);

  const activePrivateMessages = activePrivateUser
    ? privateMessagesByUser[activePrivateUser.id] ?? []
    : [];

  const typingText = useMemo(() => {
    if (chatMode !== "room" || typingUsers.length === 0) {
      return "";
    }

    if (typingUsers.length === 1) {
      return `${typingUsers[0]} is typing`;
    }

    return `${typingUsers.slice(0, 2).join(", ")} are typing`;
  }, [chatMode, typingUsers]);

  async function handleLogin(event) {
    event.preventDefault();

    const nextLoginName = loginName.trim();

    if (!nextLoginName) {
      setError("Display name is required.");
      return;
    }

    setLoginLoading(true);
    setError("");

    try {
      const response = await api.post("/api/login", { username: nextLoginName });
      const nextSession = response.data.user;

      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(nextSession));
      localStorage.setItem("chat:name", nextSession.username);
      setSession(nextSession);
      setLoginName(nextSession.username);
    } catch (loginError) {
      setError(
        loginError.response?.data?.error ??
          "Login failed. Check that the backend is running."
      );
    } finally {
      setLoginLoading(false);
    }
  }

  function handleLogout() {
    socketRef.current?.disconnect();
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem("chat:name");
    setSession(null);
    setLoginName("");
    setChatMode("room");
    setMessages([]);
    setUsers([]);
    setOnlineUsers([]);
    setActivePrivateUser(null);
    setPrivateMessagesByUser({});
    setPrivateUnreadCounts({});
    setTypingUsers([]);
    setMessageText("");
    setPrivateMessageText("");
    setStatus("offline");
    setError("");
  }

  function handleJoinRoom(event, selectedRoom) {
    event?.preventDefault();

    if (!session) {
      setError("Login before joining a room.");
      return;
    }

    const nextRoom = String(selectedRoom ?? roomInput).trim();

    if (!nextRoom) {
      setError("Room is required.");
      return;
    }

    activeRoomRef.current = nextRoom;
    chatModeRef.current = "room";
    setChatMode("room");
    setActivePrivateUser(null);
    setError("");

    socketRef.current?.emit(
      "room:join",
      {
        room: nextRoom,
        userId: session.id,
        username: session.username
      },
      (response) => {
        if (!response?.ok) {
          setError(response?.error ?? "Unable to join room.");
        }
      }
    );
  }

  function handleOpenPrivateChat(user) {
    if (!session) {
      setError("Login before opening private chat.");
      return;
    }

    activePrivateUserRef.current = user;
    chatModeRef.current = "private";
    setActivePrivateUser(user);
    setChatMode("private");
    setPrivateMessageText("");
    setPrivateUnreadCounts((currentCounts) => {
      const nextCounts = { ...currentCounts };
      delete nextCounts[user.id];
      return nextCounts;
    });
    setError("");

    socketRef.current?.emit("private:history", { userId: user.id }, (response) => {
      if (!response?.ok) {
        setError(response?.error ?? "Unable to load private chat.");
        return;
      }

      setPrivateMessagesByUser((currentMessagesByUser) => ({
        ...currentMessagesByUser,
        [user.id]: response.messages ?? []
      }));
    });
  }

  function handleBackToRoom() {
    chatModeRef.current = "room";
    setChatMode("room");
    setActivePrivateUser(null);
    setPrivateMessageText("");
  }

  function handleMessageChange(event) {
    const nextText = event.target.value;
    setMessageText(nextText);

    if (!socketRef.current?.connected) {
      return;
    }

    socketRef.current.emit("typing:start");
    window.clearTimeout(typingTimerRef.current);
    typingTimerRef.current = window.setTimeout(() => {
      socketRef.current?.emit("typing:stop");
    }, 800);
  }

  function handleSendMessage(event) {
    event.preventDefault();

    const nextMessage = messageText.trim();

    if (!nextMessage) {
      return;
    }

    setMessageText("");
    socketRef.current?.emit("typing:stop");
    socketRef.current?.emit("chat:send", { message: nextMessage }, (response) => {
      if (!response?.ok) {
        setError(response?.error ?? "Message could not be sent.");
      }
    });
  }

  function handleSendPrivateMessage(event) {
    event.preventDefault();

    const nextMessage = privateMessageText.trim();

    if (!nextMessage || !activePrivateUser) {
      return;
    }

    setPrivateMessageText("");
    socketRef.current?.emit(
      "private:send",
      {
        toUserId: activePrivateUser.id,
        message: nextMessage
      },
      (response) => {
        if (!response?.ok) {
          setError(response?.error ?? "Private message could not be sent.");
        }
      }
    );
  }

  function isOwnMessage(message) {
    if (!session) {
      return false;
    }

    if (message.userId) {
      return message.userId === session.id;
    }

    return message.username === session.username;
  }

  function isOwnPrivateMessage(message) {
    return message.fromUserId === session?.id;
  }

  if (!session) {
    return (
      <main className="login-page">
        <section className="login-panel" aria-labelledby="login-title">
          <img
            className="login-photo"
            src="https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=1200&q=80"
            alt="Laptop with chat messages"
          />

          <div className="login-content">
            <p className="label">Socket Chat</p>
            <h1 id="login-title">Enter your name</h1>

            {error ? <div className="error-banner login-error">{error}</div> : null}

            <form className="login-form" onSubmit={handleLogin}>
              <label>
                Display name
                <input
                  value={loginName}
                  maxLength={24}
                  onChange={(event) => setLoginName(event.target.value)}
                  autoComplete="name"
                  autoFocus
                />
              </label>

              <button disabled={loginLoading} type="submit">
                {loginLoading ? "Logging in..." : "Continue to chat"}
              </button>
            </form>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Room controls">
        <img
          className="room-photo"
          src="https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=900&q=80"
          alt="People talking at a table"
        />

        <div className="status-row">
          <span className={`status-dot ${status}`} aria-hidden="true" />
          <span>{status === "connected" ? "Connected" : "Offline"}</span>
        </div>

        <div className="account-panel">
          <span>Signed in as</span>
          <strong>{session.username}</strong>
          <button className="secondary-button" type="button" onClick={handleLogout}>
            Logout
          </button>
        </div>

        <form className="join-form" onSubmit={handleJoinRoom}>
          <label>
            Room
            <input
              value={roomInput}
              maxLength={32}
              onChange={(event) => setRoomInput(event.target.value)}
              autoComplete="off"
            />
          </label>

          <button type="submit">Join room</button>
        </form>

        <section className="room-section" aria-labelledby="rooms-title">
          <div className="section-title" id="rooms-title">
            Rooms
          </div>

          <div className="room-list">
            {sortedRooms.map((room) => (
              <button
                className={`room-button ${
                  chatMode === "room" && room.name === activeRoom ? "active" : ""
                }`}
                key={room.name}
                type="button"
                onClick={() => handleJoinRoom(null, room.name)}
              >
                <span>#{room.name}</span>
                <small>{room.userCount} online</small>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <section
        className="chat-panel"
        aria-label={
          chatMode === "private"
            ? `Private chat with ${activePrivateUser?.name ?? "user"}`
            : `Chat room ${activeRoom}`
        }
      >
        <header className="chat-header">
          <div>
            <p className="label">
              {chatMode === "private" ? "Direct message" : "Room"}
            </p>
            <h1>
              {chatMode === "private"
                ? activePrivateUser?.name ?? "Private chat"
                : `#${activeRoom}`}
            </h1>
          </div>

          {chatMode === "private" ? (
            <button className="secondary-button" type="button" onClick={handleBackToRoom}>
              Back to room
            </button>
          ) : (
            <strong>{users.length} online</strong>
          )}
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        <div className="messages" aria-live="polite">
          {chatMode === "room" ? (
            messages.length === 0 ? (
              <p className="empty-message">No messages yet.</p>
            ) : (
              messages.map((message) =>
                message.type === "system" ? (
                  <div className="system-message" key={message.id}>
                    {message.text}
                  </div>
                ) : (
                  <article
                    className={`message ${isOwnMessage(message) ? "own-message" : ""}`}
                    key={message.id}
                  >
                    <div className="message-meta">
                      <strong>{message.username}</strong>
                      <span>{formatTime(message.createdAt)}</span>
                    </div>
                    <p>{message.text}</p>
                  </article>
                )
              )
            )
          ) : activePrivateMessages.length === 0 ? (
            <p className="empty-message">No private messages yet.</p>
          ) : (
            activePrivateMessages.map((message) => (
              <article
                className={`message ${
                  isOwnPrivateMessage(message) ? "own-message" : ""
                }`}
                key={message.id}
              >
                <div className="message-meta">
                  <strong>{message.fromUsername}</strong>
                  <span>{formatTime(message.createdAt)}</span>
                </div>
                <p>{message.text}</p>
              </article>
            ))
          )}
        </div>

        <div className="typing-line" aria-live="polite">
          {typingText}
        </div>

        {chatMode === "room" ? (
          <form className="composer" onSubmit={handleSendMessage}>
            <input
              value={messageText}
              onChange={handleMessageChange}
              placeholder={`Message #${activeRoom}`}
              disabled={status !== "connected"}
              maxLength={1000}
            />
            <button disabled={status !== "connected"} type="submit">
              Send
            </button>
          </form>
        ) : (
          <form className="composer" onSubmit={handleSendPrivateMessage}>
            <input
              value={privateMessageText}
              onChange={(event) => setPrivateMessageText(event.target.value)}
              placeholder={
                activePrivateUser
                  ? `Message ${activePrivateUser.name}`
                  : "Choose someone online"
              }
              disabled={status !== "connected" || !activePrivateUser}
              maxLength={1000}
            />
            <button disabled={status !== "connected" || !activePrivateUser} type="submit">
              Send
            </button>
          </form>
        )}
      </section>

      <aside className="users-panel" aria-label="Online users">
        <section className="panel-section">
          <div className="section-title">Private chat</div>
          <div className="user-list">
            {directUsers.length === 0 ? (
              <p className="empty-message">No one else is online.</p>
            ) : (
              directUsers.map((user) => (
                <button
                  className={`user-row user-button ${
                    chatMode === "private" && activePrivateUser?.id === user.id
                      ? "active"
                      : ""
                  }`}
                  key={user.id}
                  type="button"
                  onClick={() => handleOpenPrivateChat(user)}
                >
                  <span aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
                  <strong>{user.name}</strong>
                  {privateUnreadCounts[user.id] ? (
                    <small className="unread-badge">{privateUnreadCounts[user.id]}</small>
                  ) : (
                    <small>
                      {user.connectionCount > 1
                        ? `${user.connectionCount} tabs`
                        : "Online"}
                    </small>
                  )}
                </button>
              ))
            )}
          </div>
        </section>

        <section className="panel-section">
          <div className="section-title">Room online</div>
          <div className="user-list">
            {users.length === 0 ? (
              <p className="empty-message">Nobody is here yet.</p>
            ) : (
              users.map((user) => (
                <div className="user-row" key={user.connectionId}>
                  <span aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
                  <strong>{user.name}</strong>
                  {user.id === session.id ? <small>You</small> : null}
                </div>
              ))
            )}
          </div>
        </section>
      </aside>
    </main>
  );
}

export default App;
