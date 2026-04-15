# Socket-io-poc

Two-package chat room proof of concept:

- `backend`: Node.js, Express, Socket.IO
- `frontend`: Vite, React, Axios, Socket.IO client

The app uses a simple name-only login flow. The frontend posts the display name
to `POST /api/login`, stores the returned session in `localStorage`, and sends
that user data when joining chat rooms through Socket.IO.

The chat supports both shared room messages and private messages. Private
messages are sent through Socket.IO events and are stored in memory by user pair
for the current backend process.

## Run locally

Install dependencies:

```bash
cd backend
npm install

cd ../frontend
npm install
```

Start the backend:

```bash
cd backend
npm run dev
```

Start the frontend in a second terminal:

```bash
cd frontend
npm run dev
```

Default URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

## Environment

Backend values can be copied from `backend/.env.example`.
Frontend values can be copied from `frontend/.env.example`.
