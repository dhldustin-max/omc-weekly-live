// GET /api/me — who is signed in and which stores they may see ("*" = all).
import { json } from "../../hub/lib.js";
export const onRequestGet = ({ data }) => json(data.user);
