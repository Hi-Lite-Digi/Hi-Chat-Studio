import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import test from "node:test";

async function loadWorker(suffix = "") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${suffix}`);
  return (await import(workerUrl.href)).default;
}

const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
const context = { waitUntil() {}, passThroughOnException() {} };

test("renders the Hi-Lite demo setup", async () => {
  const worker = await loadWorker("page");
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Hi-Lite Demo Studio/);
  assert.match(html, /Give us a store/);
  assert.match(html, /Build my demo/);
  assert.match(html, /WhatsApp sales demo/);
  assert.doesNotMatch(html, /codex-preview/);
});

test("rejects private-network links", async () => {
  const worker = await loadWorker("api");
  const response = await worker.fetch(
    new Request("http://localhost/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://127.0.0.1/private" }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 400);
});

test("customer assistant never calls itself a demo", async () => {
  const worker = await loadWorker("chat");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Hi, what do you sell?",
        sessionId: "test",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "Rooma SG",
          summary: "Furniture store",
          domain: "rooma.com.sg",
          policies: [],
          products: [{ id: "1", name: "Hiro Chair", price: 0, currency: "SGD", description: "Solid wood chair", category: "Seating" }],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.doesNotMatch(data.reply, /\bdemo\b/i);
  assert.match(data.reply, /Seating|shopping assistant/i);
  assert.ok(data.reply.trim().split(/\s+/).length <= 45);
  assert.ok(data.products.length <= 4);
});

test("sales assistant answers as the store with exact product details", async () => {
  const worker = await loadWorker("exact-product");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "a regular Hiro Chair",
        sessionId: "test-exact",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "Rooma SG",
          summary: "Furniture store",
          domain: "rooma.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Hiro Chair", price: 0, currency: "SGD", description: "A solid teak chair for everyday dining.", category: "Seating", attributes: ["Material: Teak", "Color: Natural"] },
            { id: "2", name: "Hiro Chair (Half-Arm)", price: 0, currency: "SGD", description: "A half-arm dining chair.", category: "Seating", attributes: ["Material: Teak"] },
            { id: "3", name: "Hiro-half Armchair", price: 0, currency: "SGD", description: "An upholstered half-arm chair.", category: "Seating" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].name, "Hiro Chair");
  assert.match(data.reply, /we carry Hiro Chair/i);
  assert.match(data.reply, /Teak/);
  assert.match(data.reply, /Natural finish/);
  assert.match(data.reply, /priced by quote/i);
  assert.doesNotMatch(data.reply, /based on what|price on request/i);
});

test("unknown-price products are not claimed to be under budget", async () => {
  const worker = await loadWorker("budget");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Anything under $80?",
        sessionId: "test-budget",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "Rooma SG",
          summary: "Furniture store",
          domain: "rooma.com.sg",
          policies: [],
          products: [{ id: "1", name: "Hiro Chair", price: 0, currency: "SGD", description: "Solid wood chair", category: "Seating" }],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 0);
  assert.match(data.reply, /don’t have a product with a published price under \$80/i);
});

test("a greeting with a product request is treated as buying intent", async () => {
  const worker = await loadWorker("buying-intent");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Hi, do you have a blue Sarasa pen?",
        sessionId: "test-buying-intent",
        guardrail: "flexible",
        history: [{ role: "customer", text: "Hi, do you have a blue Sarasa pen?" }],
        profile: {
          name: "Popular Bookstore",
          summary: "Books and stationery",
          domain: "popular.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Zebra Sarasa Clip Gel Pen 0.5mm", price: 1.8, currency: "SGD", description: "Smooth gel pen", category: "Stationery", attributes: ["COLOR: LIGHT BLUE | PINK"] },
            { id: "2", name: "Zebra JJZ15 Sarasa Clip GP 0.5mm", price: 1.8, currency: "SGD", description: "Smooth Sarasa pen", category: "Stationery", attributes: ["COLOR: BLACK | BLUE | RED"] },
            { id: "3", name: "Faber-Castell Blue Pen", price: 2.4, currency: "SGD", description: "Blue pen", category: "Stationery" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 0);
  assert.match(data.reply, /Sarasa is listed as a Zebra range/i);
  assert.match(data.reply, /different brand/i);
  assert.doesNotMatch(data.reply, /I’m .*sales assistant|What are you shopping for/i);
});

test("says an exact requested variation is unavailable instead of substituting", async () => {
  const worker = await loadWorker("unavailable-variation");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Do you have a navy Sarasa pen?",
        sessionId: "test-unavailable",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "Popular Bookstore",
          summary: "Books and stationery",
          domain: "popular.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Zebra JJZ15 Sarasa Clip GP 0.5mm", price: 1.8, currency: "SGD", description: "Smooth Sarasa pen", category: "Stationery", attributes: ["COLOR: BLACK | BLUE | RED"] },
            { id: "2", name: "Navy Notebook", price: 4.5, currency: "SGD", description: "Navy cover", category: "Stationery" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 0);
  assert.match(data.reply, /don’t have an exact match.*navy Sarasa pen/i);
});

test("remembers the requested item for a price follow-up", async () => {
  const worker = await loadWorker("conversation-memory");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "How much is it?",
        sessionId: "test-memory",
        guardrail: "flexible",
        history: [
          { role: "customer", text: "I want to buy a blue Sarasa pen" },
          { role: "bot", text: "Sarasa is listed as a Zebra range. Do you want the Zebra Sarasa blue pen?" },
          { role: "customer", text: "Yes, Zebra" },
          { role: "bot", text: "Yes, we have a matching Zebra Sarasa pen." },
          { role: "customer", text: "How much is it?" },
        ],
        profile: {
          name: "Popular Bookstore",
          summary: "Books and stationery",
          domain: "popular.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Zebra JJZ15 Sarasa Clip GP 0.5mm", price: 1.8, currency: "SGD", description: "Smooth Sarasa pen", category: "Stationery", attributes: ["COLOR: BLACK | BLUE | RED"] },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products[0].name, "Zebra JJZ15 Sarasa Clip GP 0.5mm");
  assert.match(data.reply, /\$1\.80/);
});

test("a rejected brand is not shown again and the product need is remembered", async () => {
  const worker = await loadWorker("brand-correction");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "That’s not the brand I wanted",
        sessionId: "test-brand-correction",
        guardrail: "flexible",
        history: [
          { role: "customer", text: "I want a blue gel pen" },
          { role: "bot", text: "I found two matching options." },
          { role: "customer", text: "That’s not the brand I wanted" },
        ],
        profile: {
          name: "Popular Bookstore",
          summary: "Books and stationery",
          domain: "popular.com.sg",
          policies: [],
          products: [{ id: "1", name: "Zebra Gel Pen", price: 1.8, currency: "SGD", description: "Blue gel pen", category: "Stationery", attributes: ["COLOR: BLUE"] }],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 0);
  assert.match(data.reply, /Which brand do you want for the blue pen/i);
});

test("corrects an obvious brand typo using catalogue evidence", async () => {
  const worker = await loadWorker("brand-typo");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "so you have a piolte blue pen?",
        sessionId: "test-brand-typo",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "Popular Bookstore",
          summary: "Books and stationery",
          domain: "popular.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Pilot G2 Blue Gel Pen", price: 2.6, currency: "SGD", description: "Smooth blue gel pen", category: "Stationery", attributes: ["COLOR: BLUE"] },
            { id: "2", name: "Pilot Permanent Marker", price: 2.2, currency: "SGD", description: "Pilot marker", category: "Stationery", attributes: ["COLOR: BLUE"] },
            { id: "3", name: "Pilot Juice Refill", price: 1.1, currency: "SGD", description: "Pilot pen refill", category: "Stationery", attributes: ["COLOR: BLUE"] },
            { id: "4", name: "Zebra Blue Ball Pen", price: 1.8, currency: "SGD", description: "Blue ball pen", category: "Stationery", attributes: ["COLOR: BLUE"] },
            { id: "5", name: "Maths Workbook", price: 17.95, currency: "SGD", description: "Primary workbook", category: "Books" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].name, "Pilot G2 Blue Gel Pen");
  assert.match(data.reply, /Pilot G2 Blue Gel Pen/i);
  assert.doesNotMatch(data.reply, /don’t have an exact match/i);
});

test("accepting alternatives keeps the earlier colour and product type", async () => {
  const worker = await loadWorker("alternative-memory");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "sure what do you have ??",
        sessionId: "test-alternative-memory",
        guardrail: "flexible",
        history: [
          { role: "customer", text: "so you have a piolte blue pen?" },
          { role: "bot", text: "We don’t have an exact match. I can show you the closest alternatives." },
          { role: "customer", text: "sure what do you have ??" },
        ],
        profile: {
          name: "Popular Bookstore",
          summary: "Books and stationery",
          domain: "popular.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Zebra Blue Gel Pen", price: 1.8, currency: "SGD", description: "Smooth blue pen", category: "Stationery", attributes: ["COLOR: BLUE"] },
            { id: "2", name: "Faber-Castell Blue Ball Pen", price: 2.4, currency: "SGD", description: "Blue ball pen", category: "Stationery", attributes: ["COLOR: BLUE"] },
            { id: "3", name: "Conquer Mathematics Workbook", price: 17.95, currency: "SGD", description: "Primary workbook", category: "Books" },
            { id: "4", name: "Blue Notebook", price: 4.5, currency: "SGD", description: "Blue cover notebook", category: "Stationery", attributes: ["COLOR: BLUE"] },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 2);
  assert.ok(data.products.every((product) => /blue.*pen|pen.*blue/i.test(product.name)));
  assert.match(data.reply, /closest blue pen alternatives/i);
  assert.doesNotMatch(data.reply, /workbook|notebook/i);
});

test("keeps the requested product in a natural compound pricing question", async () => {
  const worker = await loadWorker("compound-product-question");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Do you have a MacBook Air and how much is it?",
        sessionId: "test-compound-question",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "Apple Store",
          summary: "Technology store",
          domain: "apple.com",
          policies: [],
          products: [
            { id: "1", name: "MacBook Air", price: 1899, currency: "SGD", description: "Available from the Apple Store.", category: "Mac" },
            { id: "2", name: "iPhone 17", price: 1299, currency: "SGD", description: "Available from the Apple Store.", category: "Phones" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].name, "MacBook Air");
  assert.match(data.reply, /\$1,899\.00/);
});

test("matches Nike colour lists and returns exactly the three displayed options", async () => {
  const worker = await loadWorker("nike-products");
  const products = Array.from({ length: 8 }, (_, index) => ({
    id: `nike-${index}`,
    name: `Nike Air Force 1 '07 ${index + 1}`,
    price: 165 + index,
    currency: "SGD",
    description: "Men's everyday lifestyle shoe.",
    category: "Men's Shoes",
    attributes: ["Colours: White/White | Black/Black"],
  }));
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "I want black Air Force 1 men's shoes under $200",
        sessionId: "test-nike-products",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "Nike.com",
          summary: "Nike footwear and apparel",
          domain: "nike.com",
          policies: [],
          products,
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 3);
  assert.ok(data.products.every((product) => /Air Force 1/i.test(product.name)));
  assert.match(data.reply, /3 matching options/i);
});

test("keeps gaming laptop context when the customer adds a budget", async () => {
  const worker = await loadWorker("laptop-budget-memory");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Do you have any under SGD 2,000?",
        sessionId: "test-laptop-budget",
        guardrail: "flexible",
        history: [
          { role: "customer", text: "I want a gaming laptop. Can you show me a few options?" },
          { role: "bot", text: "What budget are you working with?" },
          { role: "customer", text: "Do you have any under SGD 2,000?" },
        ],
        profile: {
          name: "Popular Bookstore",
          summary: "Books, stationery, and Gadgets & IT",
          domain: "popular.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Lenovo IdeaPad Slim 3", price: 699, currency: "SGD", description: "Everyday Lenovo notebook computer", category: "Gadgets & IT" },
            { id: "2", name: "Apple MacBook Neo 13-inch", price: 939, currency: "SGD", description: "Everyday Apple computer", category: "Gadgets & IT" },
            { id: "3", name: "AGVA Laptop Sleeve", price: 19.9, currency: "SGD", description: "Protective sleeve", category: "Gadgets & IT" },
            { id: "4", name: "Pilot Permanent Marker", price: 1.2, currency: "SGD", description: "Black marker", category: "Stationery" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.provider, "catalogue-guard");
  assert.equal(data.products.length, 0);
  assert.match(data.reply, /gaming laptop.*under.*2,000/i);
  assert.match(data.reply, /catalogue loaded for this demo/i);
  assert.match(data.reply, /other laptops/i);
  assert.doesNotMatch(data.reply, /marker|pen|stationery/i);
});

test("recommends chairs for a natural comfort request within the customer's budget", async () => {
  const worker = await loadWorker("chair-comfort-budget");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "Hi im looking for a chair and my budget is around 600. I have lower back pains, are you able to recommend anything based on my budget?",
        sessionId: "test-chair-comfort-budget",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "HINOMI SG",
          summary: "Ergonomic office furniture",
          domain: "hinomi.co",
          policies: [],
          products: [
            { id: "1", name: "H1 Pro Ergonomic Chair", price: 549, currency: "SGD", description: "Adjustable ergonomic office chair with lumbar support for comfortable sitting.", category: "Office Chairs", attributes: ["Features: Adjustable lumbar support"] },
            { id: "2", name: "Basic Dining Chair", price: 199, currency: "SGD", description: "A simple dining chair.", category: "Dining Chairs" },
            { id: "3", name: "Executive Ergonomic Chair", price: 699, currency: "SGD", description: "Premium ergonomic chair with adjustable lumbar support.", category: "Office Chairs" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.notEqual(data.provider, "catalogue-guard");
  assert.doesNotMatch(data.reply, /don(?:'|’)t have an exact match/i);
  assert.equal(data.products[0]?.name, "H1 Pro Ergonomic Chair");
  assert.ok(data.products.every((product) => product.price <= 600));
  assert.ok(data.products.every((product) => /chair/i.test(`${product.name} ${product.category}`)));
});

test("remembers the chair and comfort need when a follow-up lowers the budget", async () => {
  const worker = await loadWorker("chair-budget-follow-up");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "anything under 500?",
        sessionId: "test-chair-budget-follow-up",
        guardrail: "flexible",
        history: [
          { role: "customer", text: "Hi im looking for a chair and my budget is around 600. I have lower back pains, are you able to recommend anything based on my budget?" },
          { role: "bot", text: "I can recommend a few ergonomic chairs within your budget." },
        ],
        profile: {
          name: "HINOMI SG",
          summary: "Ergonomic office furniture",
          domain: "hinomi.co",
          policies: [],
          products: [
            { id: "1", name: "H1 Classic Ergonomic Chair", price: 479, currency: "SGD", description: "Ergonomic office chair with adjustable lumbar support.", category: "Office Chairs", attributes: ["Features: Adjustable lumbar support"] },
            { id: "2", name: "Basic Dining Chair", price: 199, currency: "SGD", description: "A simple dining chair.", category: "Dining Chairs" },
            { id: "3", name: "H1 Pro Ergonomic Chair", price: 549, currency: "SGD", description: "Premium ergonomic chair with lumbar support.", category: "Office Chairs" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.notEqual(data.provider, "catalogue-guard");
  assert.doesNotMatch(data.reply, /don(?:'|’)t have an exact match/i);
  assert.equal(data.products[0]?.name, "H1 Classic Ergonomic Chair");
  assert.ok(data.products.every((product) => product.price <= 500));
  assert.ok(data.products.every((product) => /chair/i.test(`${product.name} ${product.category}`)));
});

test("switches from tables to chairs while retaining the latest budget", async () => {
  const worker = await loadWorker("table-to-chair-context-switch");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "what about a chair?",
        sessionId: "test-table-to-chair-context-switch",
        guardrail: "flexible",
        history: [
          { role: "customer", text: "can you recommend me anything that is less than 500?" },
          { role: "bot", text: "What kind of item are you looking for within that budget?" },
          { role: "customer", text: "I would like table" },
          { role: "bot", text: "I can’t confirm a table under SGD 500 from the loaded catalogue." },
        ],
        profile: {
          name: "HINOMI SG",
          summary: "Ergonomic office furniture",
          domain: "hinomi.co",
          policies: [],
          products: [
            { id: "1", name: "Hinomi H1 Classic V3 Ergonomic Office Chair", price: 399, currency: "SGD", description: "Ergonomic office chair with lumbar support.", category: "Seating" },
            { id: "2", name: "Hinomi Zee V2 Ergonomic Chair for Kids", price: 429, currency: "SGD", description: "Adjustable ergonomic chair for children.", category: "Seating" },
            { id: "3", name: "Hinomi Children's Ergonomic Lift Study Desk", price: 539, currency: "SGD", description: "Adjustable study desk.", category: "Tables & desks" },
            { id: "4", name: "Silent Chair Casters | Replacement Wheels", price: 39, currency: "SGD", description: "Replacement caster wheels for office chairs.", category: "Seating" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.notEqual(data.provider, "catalogue-guard");
  assert.deepEqual(data.products.map((product) => product.name), ["Hinomi H1 Classic V3 Ergonomic Office Chair"]);
  assert.ok(data.products.every((product) => product.price < 500));
  assert.ok(data.products.every((product) => !/table|desk|caster|wheel/i.test(product.name)));
});

test("returns laptops without laptop accessories for a laptop request", async () => {
  const worker = await loadWorker("laptop-product-filter");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "What laptops do you sell?",
        sessionId: "test-laptop-filter",
        guardrail: "flexible",
        history: [],
        profile: {
          name: "Popular Bookstore",
          summary: "Books, stationery, and Gadgets & IT",
          domain: "popular.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Lenovo IdeaPad Slim 3", price: 699, currency: "SGD", description: "Everyday Lenovo notebook computer", category: "Gadgets & IT" },
            { id: "2", name: "Apple MacBook Neo 13-inch", price: 939, currency: "SGD", description: "Everyday Apple computer", category: "Gadgets & IT" },
            { id: "3", name: "AGVA Urban Laptop Backpack", price: 59.9, currency: "SGD", description: "Laptop backpack", category: "Gadgets & IT" },
            { id: "4", name: "AGVA Laptop Sleeve", price: 19.9, currency: "SGD", description: "Protective sleeve", category: "Gadgets & IT" },
            { id: "5", name: "Pilot Permanent Marker", price: 1.2, currency: "SGD", description: "Black marker", category: "Stationery" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.products.map((product) => product.name), ["Lenovo IdeaPad Slim 3", "Apple MacBook Neo 13-inch"]);
});

test("selects the matching numbered product option from chat history", async () => {
  const worker = await loadWorker("numbered-option-selection");
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "2",
        sessionId: "test-option-selection",
        guardrail: "flexible",
        history: [
          {
            role: "bot",
            text: "Here are two laptops.\nOption 1: Lenovo IdeaPad Slim 3 | Price: $699.00 | Category: Gadgets & IT\nOption 2: Apple MacBook Neo 13-inch | Price: $939.00 | Category: Gadgets & IT",
          },
          { role: "customer", text: "2" },
        ],
        profile: {
          name: "Popular Bookstore",
          summary: "Books, stationery, and Gadgets & IT",
          domain: "popular.com.sg",
          policies: [],
          products: [
            { id: "1", name: "Lenovo IdeaPad Slim 3", price: 699, currency: "SGD", description: "Everyday Lenovo notebook computer", category: "Gadgets & IT" },
            { id: "2", name: "Apple MacBook Neo 13-inch", price: 939, currency: "SGD", description: "Everyday Apple computer", category: "Gadgets & IT" },
          ],
        },
      }),
    }),
    env,
    context,
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.products.length, 1);
  assert.equal(data.products[0].name, "Apple MacBook Neo 13-inch");
  assert.match(data.reply, /Apple MacBook Neo 13-inch/i);
  assert.match(data.reply, /\$939\.00/);
});

test("ships an importable n8n sales-brain workflow", async () => {
  const workflow = JSON.parse(await readFile(new URL("../n8n/hi-lite-multi-store-sales-brain.json", import.meta.url), "utf8"));
  assert.equal(workflow.name, "Hi-Lite - Multi-store Sales Brain");
  assert.equal(workflow.active, false);
  assert.ok(workflow.nodes.some((node) => node.type === "n8n-nodes-base.webhook" && node.parameters.path === "hi-lite-sales-brain"));
  assert.ok(workflow.nodes.some((node) => node.type === "@n8n/n8n-nodes-langchain.agent"));
  assert.ok(workflow.nodes.some((node) => node.type === "@n8n/n8n-nodes-langchain.lmChatOpenAi"));
  assert.ok(workflow.nodes.some((node) => node.type === "n8n-nodes-base.respondToWebhook"));
});

test("uses local n8n as the primary sales brain when configured", async () => {
  let receivedBody;
  let receivedWorkflowKey;
  const mockN8n = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedWorkflowKey = request.headers["x-hi-lite-workflow-key"];
      receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const reply = /chair under \$500/i.test(receivedBody.customerMessage)
        ? "Yes—we have chairs under $500. Option 1: Hinomi Q1 — SGD 279. Option 2: Hinomi Q2 — SGD 359. Option 3: Hinomi Q2 Pro — SGD 459. Which would you like details on?"
        : "Yes—we carry the Hiro Chair in teak with a natural finish. I can arrange the exact quote for you.";
      const sendReply = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ reply }));
      };
      if (receivedBody.sessionId === "test-n8n-timeout") setTimeout(sendReply, 80);
      else sendReply();
    });
  });
  await new Promise((resolve) => mockN8n.listen(0, "127.0.0.1", resolve));
  const address = mockN8n.address();
  assert.ok(address && typeof address === "object");
  process.env.N8N_WEBHOOK_URL = `http://localhost:${address.port}/webhook/hi-lite-sales-brain`;
  process.env.N8N_WORKFLOW_KEY = "test-workflow-key";
  process.env.N8N_REQUIRED = "true";
  process.env.N8N_ALLOW_LOCALHOST = "true";
  try {
    const worker = await loadWorker("n8n-primary");
    const response = await worker.fetch(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Do you have a regular Hiro Chair?",
          sessionId: "test-n8n",
          guardrail: "flexible",
          history: [],
          profile: {
            name: "Rooma SG",
            summary: "Furniture store",
            domain: "rooma.com.sg",
            policies: [],
            products: [
              { id: "1", name: "Hiro Chair", price: 0, currency: "SGD", description: "Solid teak dining chair", category: "Seating", attributes: ["Material: Teak", "Color: Natural"] },
              { id: "2", name: "Dining Table", price: 899, currency: "SGD", description: "Oak dining table", category: "Tables & desks" },
            ],
          },
        }),
      }),
      env,
      context,
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.provider, "n8n");
    assert.match(data.reply, /Hiro Chair/);
    assert.equal(receivedWorkflowKey, "test-workflow-key");
    assert.equal(receivedBody.business.name, "Rooma SG");
    assert.equal(receivedBody.business.products[0].name, "Hiro Chair");
    assert.equal(receivedBody.business.catalogueMatch.exactCatalogueMatch, true);
    assert.equal(receivedBody.catalogueOverview.totalProducts, 2);
    assert.match(receivedBody.instructions, /32 words or fewer/);
    assert.match(receivedBody.instructions, /real WhatsApp salesperson/);
    assert.match(receivedBody.instructions, /gives only a budget/i);

    const missingResponse = await worker.fetch(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Do you have a gaming laptop under $1,000?",
          sessionId: "test-n8n-missing-item",
          guardrail: "flexible",
          history: [],
          profile: {
            name: "Rooma SG",
            summary: "Furniture store",
            domain: "rooma.com.sg",
            policies: [],
            products: [
              { id: "1", name: "Hiro Chair", price: 0, currency: "SGD", description: "Solid teak dining chair", category: "Seating" },
              { id: "2", name: "Dining Table", price: 899, currency: "SGD", description: "Oak dining table", category: "Tables & desks" },
            ],
          },
        }),
      }),
      env,
      context,
    );
    assert.equal(missingResponse.status, 200);
    const missingData = await missingResponse.json();
    assert.equal(missingData.provider, "n8n");
    assert.equal(receivedBody.business.catalogueMatch.exactCatalogueMatch, false);
    assert.equal(receivedBody.business.catalogueMatch.budget, 1000);
    assert.deepEqual(receivedBody.business.catalogueMatch.requestedProductTypes, ["laptop"]);
    assert.deepEqual(receivedBody.business.products, []);

    const broadBudgetResponse = await worker.fetch(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Can you recommend me anything that is less than 500?",
          sessionId: "test-n8n-broad-budget",
          guardrail: "flexible",
          history: [],
          profile: {
            name: "HINOMI SG",
            summary: "Ergonomic office furniture",
            domain: "hinomi.co",
            policies: [],
            products: [
              { id: "1", name: "H1 Classic Ergonomic Chair", price: 399, currency: "SGD", description: "Office chair", category: "Seating" },
              { id: "2", name: "Children's Study Desk", price: 539, currency: "SGD", description: "Study desk", category: "Tables & desks" },
            ],
          },
        }),
      }),
      env,
      context,
    );
    assert.equal(broadBudgetResponse.status, 200);
    const broadBudgetData = await broadBudgetResponse.json();
    assert.equal(broadBudgetData.provider, "n8n");
    assert.match(broadBudgetData.reply, /under (?:(?:SGD\s*)?\$?500)/i);
    assert.match(broadBudgetData.reply, /what kind of item/i);
    assert.doesNotMatch(broadBudgetData.reply, /seating|tables|desks|computer accessories/i);
    assert.deepEqual(broadBudgetData.products, []);

    const alignedOptionsResponse = await worker.fetch(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Hi I want a chair under $500",
          sessionId: "test-n8n-aligned-options",
          guardrail: "flexible",
          history: [],
          profile: {
            name: "HINOMI SG",
            summary: "Ergonomic office furniture",
            domain: "hinomi.co",
            policies: [],
            products: [
              { id: "mat", name: "Chair Floor Mat", price: 29.9, currency: "SGD", description: "Floor protection mat", category: "Seating" },
              { id: "lift", name: "Chair Gas Lift/Cylinder", price: 50, currency: "SGD", description: "Replacement chair part", category: "Seating" },
              { id: "kid", name: "Hinomi Children's Verte Ergonomic Saddle Chair", price: 199, currency: "SGD", description: "Ergonomic chair for children", category: "Seating" },
              { id: "q1", name: "Hinomi Q1 Ergonomic Office Chair", price: 279, currency: "SGD", description: "Ergonomic adult office chair", category: "Seating" },
              { id: "q2", name: "Hinomi Q2 Ergonomic Office Chair", price: 359, currency: "SGD", description: "Ergonomic adult office chair", category: "Seating" },
              { id: "q2-pro", name: "Hinomi Q2 Pro Ergonomic Office Chair", price: 459, currency: "SGD", description: "Premium ergonomic adult office chair", category: "Seating" },
            ],
          },
        }),
      }),
      env,
      context,
    );
    assert.equal(alignedOptionsResponse.status, 200);
    const alignedOptionsData = await alignedOptionsResponse.json();
    assert.equal(alignedOptionsData.provider, "n8n");
    assert.equal(alignedOptionsData.reply, "Yes—we have chairs under $500. Option 1: Hinomi Q1 — SGD 279. Option 2: Hinomi Q2 — SGD 359. Option 3: Hinomi Q2 Pro — SGD 459. Which would you like details on?");
    assert.deepEqual(alignedOptionsData.products.map((product) => product.name), [
      "Hinomi Q1 Ergonomic Office Chair",
      "Hinomi Q2 Ergonomic Office Chair",
      "Hinomi Q2 Pro Ergonomic Office Chair",
    ]);
    assert.ok(alignedOptionsData.products.every((product) => !/floor mat|gas lift|cylinder|children/i.test(product.name)));

    process.env.N8N_TIMEOUT_MS = "20";
    const timeoutStartedAt = Date.now();
    const timeoutFallbackResponse = await worker.fetch(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "chairs",
          sessionId: "test-n8n-timeout",
          guardrail: "flexible",
          history: [
            { role: "customer", text: "Do you have anything under $500?" },
            { role: "bot", text: "What kind of item are you looking for?" },
          ],
          profile: {
            name: "HINOMI SG",
            summary: "Ergonomic office furniture",
            domain: "hinomi.co",
            policies: [],
            products: [
              { id: "q1", name: "Hinomi Q1 Ergonomic Office Chair", price: 279, currency: "SGD", description: "Ergonomic adult office chair", category: "Seating" },
              { id: "q2", name: "Hinomi Q2 Ergonomic Office Chair", price: 359, currency: "SGD", description: "Ergonomic adult office chair", category: "Seating" },
            ],
          },
        }),
      }),
      env,
      context,
    );
    const timeoutElapsedMs = Date.now() - timeoutStartedAt;
    delete process.env.N8N_TIMEOUT_MS;
    assert.equal(timeoutFallbackResponse.status, 200);
    const timeoutFallbackData = await timeoutFallbackResponse.json();
    assert.equal(timeoutFallbackData.provider, "local-fallback");
    assert.ok(timeoutElapsedMs < 500, `Expected a fast fallback, received it in ${timeoutElapsedMs}ms`);
    assert.doesNotMatch(timeoutFallbackData.reply, /team handoff|connect you with our team/i);
    assert.deepEqual(timeoutFallbackData.products.map((product) => product.name), [
      "Hinomi Q1 Ergonomic Office Chair",
      "Hinomi Q2 Ergonomic Office Chair",
    ]);
  } finally {
    delete process.env.N8N_WEBHOOK_URL;
    delete process.env.N8N_WORKFLOW_KEY;
    delete process.env.N8N_REQUIRED;
    delete process.env.N8N_ALLOW_LOCALHOST;
    delete process.env.N8N_TIMEOUT_MS;
    await new Promise((resolve, reject) => mockN8n.close((error) => error ? reject(error) : resolve()));
  }
});
