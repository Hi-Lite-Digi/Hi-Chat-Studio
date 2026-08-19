import { POST } from "../app/api/analyze/route.js";

export const config = { maxDuration: 60 };

export default {
  fetch(request: Request) {
    return POST(request);
  },
};
