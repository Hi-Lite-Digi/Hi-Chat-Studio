import { POST } from "../app/api/chat/route.js";

export const config = { maxDuration: 60 };

export default {
  fetch(request: Request) {
    return POST(request);
  },
};
