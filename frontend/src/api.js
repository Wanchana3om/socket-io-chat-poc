import axios from "axios";

export const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
export const SOCKET_URL = import.meta.env.VITE_SOCKET_URL ?? API_URL;

export const api = axios.create({
  baseURL: API_URL,
  timeout: 5000
});
