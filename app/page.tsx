"use client";

import { CSSProperties, FormEvent, KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

type Product = {
  id: string;
  name: string;
  price: number;
  currency: string;
  description: string;
  category: string;
  image?: string;
  url?: string;
  attributes?: string[];
  available?: boolean;
  pricePrefix?: string;
};

type Profile = {
  name: string;
  url: string;
  domain: string;
  summary: string;
  vertical: string;
  accent: string;
  products: Product[];
  policies: string[];
  sourceStatus: "live" | "partial" | "fallback" | "sample";
  sourceNote: string;
};

type Message = {
  id: string;
  role: "customer" | "bot";
  text: string;
  time: string;
  products?: Product[];
  limited?: boolean;
};

const SAMPLE_URL = "https://demo.hi-lite.store";
const MAX_CHAT_OPTIONS = 3;
const FALLBACK_MESSAGE = "I can help with products, recommendations, delivery and store questions. For this request, I’ll need to connect you with our team. Would you like me to help you choose a product in the meantime?";

function messageTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function messageHistoryText(message: Message) {
  const options = (message.products || []).slice(0, MAX_CHAT_OPTIONS);
  if (!options.length) return message.text;
  const optionText = options
    .map((product, index) => `Option ${index + 1}: ${product.name} | Price: ${formatPrice(product)} | Category: ${product.category}`)
    .join("\n");
  return `${message.text}\n${optionText}`;
}

function formatPrice(product: Product) {
  if (!product.price) return "Request a quote";
  try {
    const price = new Intl.NumberFormat("en-SG", { style: "currency", currency: product.currency || "SGD" }).format(product.price);
    return `${product.pricePrefix || ""}${price}`;
  } catch {
    return `${product.pricePrefix || ""}$${product.price.toFixed(2)}`;
  }
}

function parseManualProducts(value: string): Product[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [name, priceText = "", description = "Available from the store.", category = "Store product"] = line.split(/\s*\|\s*/);
    const price = Number(priceText.replace(/[^0-9.]/g, "")) || 0;
    const currency = /US\$|USD/i.test(priceText) ? "USD" : /RM|MYR/i.test(priceText) ? "MYR" : "SGD";
    return { id: `manual-${Date.now()}-${index}`, name, price, currency, description, category };
  });
}

function readableText(value: unknown, fallback = "Available from the online store.") {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/<[^>]*>/g, " ").replace(/&amp;/gi, "&").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 180) || fallback;
}

function browserProductCategory(name: string, explicit: unknown) {
  const provided = typeof explicit === "string" ? explicit.trim() : "";
  if (provided) return provided.slice(0, 40);
  const value = name.toLowerCase();
  if (/laptop|macbook|notebook/.test(value)) return "Laptops";
  if (/pen|pencil|marker|highlighter|stationery/.test(value)) return "Stationery";
  if (/book|workbook|novel/.test(value)) return "Books";
  if (/bag|backpack|sleeve|case/.test(value)) return "Bags & cases";
  if (/keyboard|mouse|charger|cable|headset|speaker/.test(value)) return "Gadgets & IT";
  return "Store product";
}

async function loadShopifyCatalogueInBrowser(storeUrl: string) {
  const origin = new URL(storeUrl).origin;
  const products: Product[] = [];
  for (let firstPage = 1; firstPage <= 20 && products.length < 5_000; firstPage += 4) {
    const pages = await Promise.allSettled(Array.from({ length: Math.min(4, 21 - firstPage) }, async (_, offset) => {
      const response = await fetch(`${origin}/products.json?limit=250&page=${firstPage + offset}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Catalogue returned ${response.status}.`);
      const data = await response.json() as { products?: Array<Record<string, unknown>> };
      return data.products || [];
    }));
    let reachedEnd = false;
    for (const page of pages) {
      if (page.status !== "fulfilled") continue;
      if (page.value.length < 250) reachedEnd = true;
      for (const record of page.value) {
        const variants = Array.isArray(record.variants) ? record.variants.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
        const availableVariants = variants.filter((variant) => variant.available !== false);
        const variant = availableVariants[0] || variants[0] || {};
        const images = Array.isArray(record.images) ? record.images.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
        const name = typeof record.title === "string" ? record.title.trim().slice(0, 100) : "";
        const price = Number(String(variant.price ?? "").replace(/[^0-9.]/g, ""));
        if (!name) continue;
        products.push({
          id: `shopify-${String(record.id ?? products.length)}`,
          name,
          price: Number.isFinite(price) ? price : 0,
          currency: /\.com\.sg$/i.test(new URL(origin).hostname) ? "SGD" : "USD",
          description: readableText(record.body_html),
          category: browserProductCategory(name, record.product_type),
          image: typeof images[0]?.src === "string" ? images[0].src : undefined,
          url: typeof record.handle === "string" ? `${origin}/products/${record.handle}` : undefined,
          available: variants.length ? availableVariants.length > 0 : true,
        });
      }
    }
    if (reachedEnd) break;
  }
  return products
    .filter((product, index, all) => all.findIndex((item) => item.name.toLowerCase() === product.name.toLowerCase()) === index)
    .slice(0, 5_000);
}

async function recoverBrowserCatalogue(profile: Profile) {
  if (profile.products.length) return profile;
  try {
    const products = await loadShopifyCatalogueInBrowser(profile.url);
    if (!products.length) return profile;
    return {
      ...profile,
      products,
      sourceStatus: "live" as const,
      sourceNote: `${products.length} products found in the store catalogue.`,
    };
  } catch {
    return profile;
  }
}

function StoreMark({ name, small = false }: { name: string; small?: boolean }) {
  const letters = name.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
  return <span className={small ? "store-mark small" : "store-mark"}>{letters || "S"}</span>;
}

function LandingPhone() {
  return (
    <div className="preview-stage" aria-label="Example WhatsApp bot preview">
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="phone landing-phone">
        <div className="phone-speaker" />
        <div className="phone-screen">
          <div className="chat-head">
            <span className="back-arrow">‹</span>
            <StoreMark name="Harbour Supply" small />
            <span className="chat-title"><strong>Harbour Supply</strong><small>online</small></span>
            <span className="chat-actions">•••</span>
          </div>
          <div className="chat-body landing-chat">
            <div className="date-pill">TODAY</div>
            <div className="bubble incoming">Hi! 👋 Looking for anything in particular today?<time>10:31</time></div>
            <div className="bubble outgoing">I need a non-stick pan for induction. Under $80.<time>10:32 ✓✓</time></div>
            <div className="bubble incoming product-bubble">
              <div className="product-image"><span>28</span><small>CM</small></div>
              <div className="product-copy"><strong>Nordic Pro Frypan</strong><span>Induction ready · PFOA-free</span><b>$69.90</b></div>
            </div>
            <div className="bubble incoming">This one fits perfectly. Want me to add it to your cart?<time>10:32</time></div>
          </div>
          <div className="chat-input mock"><span>＋</span><div>Message</div><b>➤</b></div>
        </div>
      </div>
      <div className="learn-badge"><span>✦</span><b>Learns the store</b><small>Products · Voice · Policies</small></div>
      <div className="reply-badge"><span>↗</span><b>Replies naturally</b><small>In the customer’s language</small></div>
    </div>
  );
}

export default function Home() {
  const [phase, setPhase] = useState<"setup" | "analyzing" | "studio">("setup");
  const [url, setUrl] = useState("");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(8);
  const [analysisStep, setAnalysisStep] = useState("Opening the store");
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [conversationNumber, setConversationNumber] = useState(0);
  const [manualProducts, setManualProducts] = useState("");
  const [catalogueQuery, setCatalogueQuery] = useState("");
  const [visibleProductCount, setVisibleProductCount] = useState(12);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const catalogueRecoveryRef = useRef(new Set<string>());
  const conversationVersionRef = useRef(0);
  const sessionRoot = useId();
  const sessionId = `${sessionRoot}-${conversationNumber}`;
  const filteredCatalogue = useMemo(() => {
    if (!profile) return [];
    const query = catalogueQuery.trim().toLowerCase();
    if (!query) return profile.products;
    return profile.products.filter((product) =>
      [product.name, product.category, product.description, ...(product.attributes || [])]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [catalogueQuery, profile]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, typing]);

  useEffect(() => {
    if (!profile || profile.products.length || !/429|temporar|unavailable/i.test(profile.sourceNote)) return;
    const recoveryKey = profile.url;
    if (catalogueRecoveryRef.current.has(recoveryKey)) return;
    catalogueRecoveryRef.current.add(recoveryKey);

    void recoverBrowserCatalogue(profile)
      .then((recovered) => {
        if (!recovered.products.length) return;
        setProfile((current) => current?.url === recoveryKey ? recovered : current);
        setCatalogueQuery("");
        setVisibleProductCount(12);
      })
      .catch(() => { /* Keep the clear catalogue-needed state if recovery is still blocked. */ });
  }, [profile]);

  async function buildDemo(storeUrl: string) {
    let normalised = storeUrl.trim();
    if (!normalised) return;
    if (!/^https?:\/\//i.test(normalised)) normalised = `https://${normalised}`;
    try { new URL(normalised); } catch { setError("Please enter a valid store website."); return; }

    setUrl(normalised);
    setError("");
    setPhase("analyzing");
    setProgress(10);
    setAnalysisStep("Opening the store");
    const steps = [
      { at: 26, text: "Reading the business and brand voice" },
      { at: 52, text: "Looking for products and prices" },
      { at: 76, text: "Preparing customer questions" },
      { at: 90, text: "Preparing the sales assistant" },
    ];
    let stepIndex = 0;
    const timer = window.setInterval(() => {
      if (stepIndex < steps.length) {
        setProgress(steps[stepIndex].at);
        setAnalysisStep(steps[stepIndex].text);
        stepIndex += 1;
      }
    }, 650);

    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: normalised }),
      });
      const data = await response.json() as { profile?: Profile; error?: string };
      if (!response.ok || !data.profile) throw new Error(data.error || "The store could not be prepared.");
      const preparedProfile = await recoverBrowserCatalogue(data.profile);
      window.clearInterval(timer);
      setProgress(100);
      setAnalysisStep("Demo ready");
      setProfile(preparedProfile);
      setCatalogueQuery("");
      setVisibleProductCount(12);
      setMessages([{
        id: "welcome",
        role: "bot",
        text: `Hi 👋 Welcome to ${preparedProfile.name}! What can I help you find today?`,
        time: messageTime(),
      }]);
      window.setTimeout(() => setPhase("studio"), 450);
    } catch (caught) {
      window.clearInterval(timer);
      setError(caught instanceof Error ? caught.message : "Something went wrong. Please try another link.");
      setPhase("setup");
    }
  }

  function submitStore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void buildDemo(url);
  }

  function addManualProducts() {
    if (!profile || !manualProducts.trim()) return;
    const additions = parseManualProducts(manualProducts);
    const products = [...profile.products, ...additions]
      .filter((product, index, all) => all.findIndex((item) => item.name.toLowerCase() === product.name.toLowerCase()) === index)
      .slice(0, 5_000);
    setProfile({ ...profile, products });
    setManualProducts("");
  }

  async function sendMessage(preset?: string) {
    if (!profile || typing) return;
    const conversationVersion = conversationVersionRef.current;
    const text = (preset ?? chatInput).trim();
    if (!text) return;
    const customerMessage: Message = { id: `customer-${Date.now()}`, role: "customer", text, time: messageTime() };
    const nextMessages = [...messages, customerMessage];
    setMessages(nextMessages);
    setChatInput("");
    setTyping(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: text,
          sessionId,
          profile,
          guardrail: "flexible",
          history: nextMessages.slice(-12).map((message) => ({ role: message.role, text: messageHistoryText(message) })),
        }),
      });
      const data = await response.json() as { reply?: string; products?: Product[]; limited?: boolean; error?: string };
      if (!response.ok || !data.reply) throw new Error(data.error || "No reply returned.");
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      if (conversationVersion !== conversationVersionRef.current) return;
      setMessages((current) => [...current, {
        id: `bot-${Date.now()}`,
        role: "bot",
        text: data.reply as string,
        time: messageTime(),
        products: data.products,
        limited: data.limited,
      }]);
    } catch {
      if (conversationVersion !== conversationVersionRef.current) return;
      setMessages((current) => [...current, { id: `bot-${Date.now()}`, role: "bot", text: FALLBACK_MESSAGE, time: messageTime(), limited: true }]);
    } finally {
      if (conversationVersion === conversationVersionRef.current) setTyping(false);
    }
  }

  function handleChatKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function resetDemo() {
    conversationVersionRef.current += 1;
    setPhase("setup");
    setProfile(null);
    setMessages([]);
    setChatInput("");
    setTyping(false);
    setChatMenuOpen(false);
    setConversationNumber((current) => current + 1);
    setUrl("");
    setError("");
    setProgress(8);
    setCatalogueQuery("");
    setVisibleProductCount(12);
  }

  function restartConversation() {
    if (!profile) return;
    conversationVersionRef.current += 1;
    setConversationNumber((current) => current + 1);
    setMessages([{
      id: `welcome-${Date.now()}`,
      role: "bot",
      text: `Hi 👋 Welcome to ${profile.name}! What can I help you find today?`,
      time: messageTime(),
    }]);
    setChatInput("");
    setTyping(false);
    setChatMenuOpen(false);
  }

  if (phase === "studio" && profile) {
    const accentStyle = { "--store-accent": profile.accent } as CSSProperties;
    return (
      <main className="studio-shell" style={accentStyle}>
        <header className="studio-topbar">
          <button type="button" className="brand" onClick={resetDemo} aria-label="Return to Hi-Lite setup">
            <span className="brand-mark">H</span><span>Hi-Lite</span><span className="brand-divider" /><span className="brand-subtitle">Demo studio</span>
          </button>
          <div className="store-chip"><span className="status-dot" /><b>{profile.name}</b><span>{profile.domain}</span></div>
          <button className="new-demo-button" onClick={resetDemo}><span>＋</span> New store</button>
        </header>

        <section className="studio-layout">
          <aside className="control-panel sales-panel">
            <div className="panel-heading">
              <div><span className="panel-kicker">STORE READY</span><h2>Your sales assistant</h2></div>
              <span className={`source-pill ${profile.sourceStatus}`}><i />{profile.sourceStatus === "live" ? `${profile.products.length} products found` : "Catalogue needed"}</span>
            </div>
            <div className="sales-summary">
              <div className="store-identity"><StoreMark name={profile.name} /><div><span>NOW ASSISTING FOR</span><h3>{profile.name}</h3><a href={profile.url} target="_blank" rel="noreferrer">Visit shop ↗</a></div></div>
              <p className="store-summary">{profile.summary}</p>
              <div className="read-note"><span>✦</span><div><b>{profile.sourceStatus === "live" ? "I’ve looked through the shop" : "Catalogue still needed"}</b><p>{profile.sourceStatus === "live" ? "I can use the products, prices and descriptions I found to guide customers." : profile.sourceNote}</p></div></div>

              <div className="product-section-heading"><h3>Products I can sell</h3><span>{profile.products.length} ready</span></div>
              <div className="catalogue-search">
                <input
                  value={catalogueQuery}
                  onChange={(event) => { setCatalogueQuery(event.target.value); setVisibleProductCount(12); }}
                  placeholder={`Search all ${profile.products.length} products`}
                  aria-label="Search the scanned catalogue"
                />
                <span>Showing {Math.min(visibleProductCount, filteredCatalogue.length)} of {filteredCatalogue.length}</span>
              </div>
              <div className="discovered-products">
                {filteredCatalogue.slice(0, visibleProductCount).map((product) => (
                  <div key={product.id} className="discovered-product">
                    <div className="discovered-product-art" style={product.image ? { backgroundImage: `url(${product.image})` } : undefined}>{!product.image && product.name.charAt(0)}</div>
                    <div><b>{product.name}</b><span>{product.category}</span><strong>{formatPrice(product)}</strong></div>
                  </div>
                ))}
                {!filteredCatalogue.length && <p className="catalogue-empty">No products match that search.</p>}
              </div>
              {visibleProductCount < filteredCatalogue.length && (
                <button className="load-products" onClick={() => setVisibleProductCount((count) => Math.min(count + 24, filteredCatalogue.length))}>
                  Show 24 more
                </button>
              )}

              <div className="sales-skills">
                <h3>How I help customers</h3>
                <div><span>01</span><p><b>Understand the need</b><small>Ask about use, preference and budget</small></p></div>
                <div><span>02</span><p><b>Recommend the right fit</b><small>Explain why each product is suitable</small></p></div>
                <div><span>03</span><p><b>Move the sale forward</b><small>Compare choices and answer objections</small></p></div>
              </div>
              <details className="manual-add">
                <summary>Missing an item? Add it</summary>
                <p>Paste one item per line, for example: Chef Knife | 48 | Stainless steel</p>
                <textarea value={manualProducts} onChange={(event) => setManualProducts(event.target.value)} rows={4} placeholder="Product | Price | Short description" aria-label="Additional products" />
                <button onClick={addManualProducts} disabled={!manualProducts.trim()}>Add to catalogue</button>
              </details>
            </div>
          </aside>

          <section className="chat-workspace">
            <div className="workspace-heading">
              <div><span className="panel-kicker">LIVE PREVIEW</span><h2>Chat like a customer</h2></div>
              <div className="preview-state"><span className="pulse" /> Sales assistant ready</div>
            </div>

            <div className="demo-phone-wrap">
              <div className="demo-phone-shadow" />
              <div className="phone studio-phone">
                <div className="phone-speaker" />
                <div className="phone-screen">
                  <div className="chat-head studio-chat-head">
                    <span className="back-arrow">‹</span><StoreMark name={profile.name} small />
                    <span className="chat-title"><strong>{profile.name}</strong><small>online</small></span>
                    <div className="chat-actions">
                      <i className="video-call-icon" aria-hidden="true" />
                      <i className="phone-call-icon" aria-hidden="true">☎</i>
                      <div className="chat-menu-wrap">
                        <button className="chat-menu-trigger" type="button" onClick={() => setChatMenuOpen((open) => !open)} aria-label="Open chat menu" aria-expanded={chatMenuOpen}>
                          <i className="menu-icon" aria-hidden="true">⋮</i>
                        </button>
                        {chatMenuOpen && (
                          <div className="chat-menu" role="menu">
                            <button type="button" role="menuitem" onClick={restartConversation}>
                              <span aria-hidden="true">↻</span>
                              <span><b>Restart chat</b><small>Keep this store and catalogue</small></span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="chat-body live-chat">
                    <div className="date-pill">TODAY</div>
                    {messages.map((message) => {
                      const options = (message.products || []).slice(0, MAX_CHAT_OPTIONS);
                      return (
                        <div key={message.id} className={`message-stack ${message.role === "customer" ? "outgoing" : "incoming"}`}>
                          <div className={`bubble ${message.role === "customer" ? "outgoing" : "incoming"} ${message.limited ? "limited" : ""} ${options.length ? "wa-rich-message" : ""}`}>
                            {message.limited && <span className="limit-label">TEAM HANDOFF</span>}
                            <span>{message.text}</span>
                            {options.length > 0 && (
                              <div className="wa-product-list" aria-label={`${options.length} product ${options.length === 1 ? "item" : "options"}`}>
                                {options.map((product, index) => (
                                  <div className="wa-product-row" key={product.id}>
                                    <span className="wa-option-index">{options.length === 1 ? "Item" : `Option ${index + 1}`}</span>
                                    <span className="wa-product-copy"><b>{product.name}</b><small>{product.category}</small></span>
                                    <strong>{formatPrice(product)}</strong>
                                  </div>
                                ))}
                              </div>
                            )}
                            <time>{message.time}{message.role === "customer" ? <span className="read-ticks"> ✓✓</span> : ""}</time>
                            {options.length > 1 && (
                              <div className="wa-reply-buttons" aria-label="Choose a product option">
                                {options.map((product, index) => (
                                  <button type="button" key={product.id} onClick={() => void sendMessage(String(index + 1))} disabled={typing} aria-label={`Choose option ${index + 1}: ${product.name}`}>
                                    <span aria-hidden="true">↪</span> Option {index + 1}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {typing && <div className="bubble incoming typing-bubble" aria-label="Bot is typing"><i /><i /><i /></div>}
                    <div ref={chatEndRef} />
                  </div>
                  <div className="live-input-row">
                    <span className="composer-plus">＋</span>
                    <div className="composer-field">
                      <span className="composer-emoji" aria-hidden="true">☺</span>
                      <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} onKeyDown={handleChatKey} placeholder="Message" aria-label="Customer message" />
                      <span className="camera-icon" aria-hidden="true" />
                    </div>
                    <button onClick={() => void sendMessage()} disabled={!chatInput.trim() || typing} aria-label="Send message"><span className="send-icon" aria-hidden="true" /></button>
                  </div>
                </div>
              </div>
            </div>

            <div className="quick-prompts">
              <span>TRY ASKING</span>
              <div>
                {["What do you recommend?", "Anything under $80?", "Do you deliver?", "Can you cancel my paid order and refund me now?"].map((prompt) => <button key={prompt} onClick={() => void sendMessage(prompt)} disabled={typing}>{prompt}</button>)}
              </div>
            </div>
          </section>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <button type="button" className="brand" aria-label="Hi-Lite demo studio home"><span className="brand-mark">H</span><span>Hi-Lite</span><span className="brand-divider" /><span className="brand-subtitle">Demo studio</span></button>
        <div className="topbar-meta"><span className="status-dot" />Demo mode</div>
      </header>
      <section className="hero-grid">
        <div className="hero-copy">
          <div className="eyebrow"><span>01</span> BUILD A DEMO</div>
          <h1>Give us a store.<br />We’ll give you <em>the bot.</em></h1>
          <p className="lede">Drop any online store link. We’ll learn the business, find its products, and spin up a WhatsApp sales demo in moments.</p>
          <form className="url-card" onSubmit={submitStore}>
            <label htmlFor="store-url">Store website</label>
            <div className="url-row">
              <span className="link-glyph">↗</span>
              <input id="store-url" type="text" inputMode="url" required placeholder="https://yourstore.com" value={url} onChange={(event) => { setUrl(event.target.value); setError(""); }} />
              <button type="submit">Build my demo <span>→</span></button>
            </div>
            <div className="url-footnote"><span>No setup. Paste products only if you want to.</span><button type="button" onClick={() => void buildDemo(SAMPLE_URL)}>Or load a sample store</button></div>
            {error && <p className="inline-error">{error}</p>}
          </form>
          <div className="steps" aria-label="How it works">
            <div><b>01</b><span><strong>Paste a link</strong>Your customer’s store</span></div>
            <div><b>02</b><span><strong>We learn it</strong>Products, tone & FAQs</span></div>
            <div><b>03</b><span><strong>Start chatting</strong>A demo built for them</span></div>
          </div>
        </div>
        <LandingPhone />
      </section>
      <footer className="site-footer"><span>BUILT FOR LIVE SALES DEMOS</span><span>Store-aware sales assistance</span></footer>

      {phase === "analyzing" && (
        <div className="analysis-overlay" role="status" aria-live="polite">
          <div className="analysis-card">
            <div className="analysis-orbit"><span className="analysis-logo">H</span><i /><i /><i /></div>
            <span className="panel-kicker">PREPARING YOUR DEMO</span>
            <h2>Learning {(() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "the store"; } })()}</h2>
            <p>{analysisStep}</p>
            <div className="progress-track"><i style={{ width: `${progress}%` }} /></div>
            <div className="analysis-meta"><span>{progress}%</span><span>Usually under a minute</span></div>
          </div>
        </div>
      )}
    </main>
  );
}
