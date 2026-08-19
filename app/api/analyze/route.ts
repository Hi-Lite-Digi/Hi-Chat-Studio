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

const MAX_HTML_BYTES = 1_250_000;
const MAX_CATALOGUE_PAGE_BYTES = 6_000_000;
const MAX_CATALOGUE_PRODUCTS = 5_000;
const MAX_DISCOVERY_PAGES = 18;
const appleCatalogueCache = new Map<string, { expiresAt: number; products: Product[] }>();
const nikeCatalogueCache = new Map<string, { expiresAt: number; products: Product[] }>();
const genericCatalogueCache = new Map<string, { expiresAt: number; staleUntil: number; products: Product[] }>();
const genericCatalogueRequests = new Map<string, Promise<Product[]>>();

function clean(value: unknown, max = 280) {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstString(value[0]);
  if (value && typeof value === "object" && "url" in value) {
    return firstString((value as { url?: unknown }).url);
  }
  return "";
}

function titleFromHost(hostname: string) {
  const root = hostname.replace(/^www\./, "").split(".")[0] || "Your Store";
  return root
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function isPrivateIpv4(hostname: string) {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function safeUrl(raw: string) {
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only website links are supported.");
  if (url.username || url.password) throw new Error("Links with sign-in details are not supported.");
  if (url.port && !['80', '443'].includes(url.port)) throw new Error("Please use a standard store link.");
  if (
    hostname === "localhost" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".local") ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    isPrivateIpv4(hostname)
  ) {
    throw new Error("Private network links are not supported.");
  }
  return url;
}

async function fetchPublicPage(initialUrl: URL, maxBytes = MAX_HTML_BYTES) {
  let current = initialUrl;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let response: Response;
    try {
      response = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-SG,en;q=0.9",
          "cache-control": "no-cache",
          pragma: "no-cache",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The store returned an incomplete redirect.");
      current = safeUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`The store returned ${response.status}.`);

    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml|application\/json/i.test(contentType)) {
      throw new Error("That link is not a readable store page.");
    }

    const reader = response.body?.getReader();
    if (!reader) return { html: "", finalUrl: current };
    const decoder = new TextDecoder();
    let html = "";
    let bytes = 0;
    while (bytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => undefined);
    return { html, finalUrl: current };
  }
  throw new Error("The store redirected too many times.");
}

function metaContent(html: string, key: string) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function collectProducts(value: unknown, output: Record<string, unknown>[]) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectProducts(item, output));
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((item) => String(item).toLowerCase() === "product")) output.push(record);
  for (const [key, child] of Object.entries(record)) {
    if (key !== "offers" && key !== "aggregateRating" && key !== "review") collectProducts(child, output);
  }
}

function inferProductCategory(name: string, explicit = "") {
  const provided = clean(explicit, 40);
  if (provided && !/^(store product|catalogue|store pick)$/i.test(provided)) return provided;
  const value = name.toLowerCase();
  const categories: Array<[RegExp, string]> = [
    [/iphone|smartphone/, "Phones"],
    [/ipad|tablet/, "Tablets"],
    [/macbook|\bimac\b|mac mini|mac studio|studio display|\bmac\b/, "Mac"],
    [/apple watch|smartwatch|watch band|sport band/, "Watches & bands"],
    [/airpods|earbuds|earphones|headphones|speaker|audio/, "Audio"],
    [/charger|power adapter|charge cable|magsafe|power bank|battery/, "Charging & power"],
    [/keyboard|mouse|trackpad|display|monitor/, "Computer accessories"],
    [/case|folio|cover|sleeve/, "Cases & protection"],
    [/chair|armchair|stool|bench|seating/, "Seating"],
    [/sofa|couch|loveseat/, "Sofas"],
    [/table|desk|console/, "Tables & desks"],
    [/shelf|bookshelf|cabinet|sideboard|drawer|wardrobe|storage/, "Storage"],
    [/bed|mattress|bedside/, "Bedroom"],
    [/lamp|light|pendant|chandelier/, "Lighting"],
    [/mirror|vase|rug|carpet|decor|clock/, "Home décor"],
    [/knife|cutting|scissor|chopper/, "Cutting tools"],
    [/pan|pot|casserole|cookware|wok/, "Cookware"],
    [/glass|tumbler|cup|mug|drinkware/, "Drinkware"],
    [/plate|bowl|dish|dinnerware|flatware|spoon|fork/, "Tableware"],
    [/machine|cooker|oven|grill|juicer|blender|processor|electrical/, "Kitchen equipment"],
    [/glove|apron|uniform|protective/, "Protective wear"],
    [/clean|mop|towel|housekeeping/, "Cleaning supplies"],
  ];
  return categories.find(([pattern]) => pattern.test(value))?.[1] || "Other products";
}

function productFromJsonLd(record: Record<string, unknown>, index: number, baseUrl: URL): Product | null {
  const name = clean(record.name, 100);
  if (!name) return null;
  const rawOffers = Array.isArray(record.offers) ? record.offers[0] : record.offers;
  const offers = asRecord(rawOffers) || {};
  const priceValue = offers.price ?? offers.lowPrice ?? record.price;
  const parsedPrice = Number(String(priceValue ?? "").replace(/[^0-9.]/g, ""));
  const rawUrl = firstString(offers.url) || firstString(record.url);
  const rawImage = firstString(record.image);
  let productUrl = "";
  let image = "";
  const additionalProperties = Array.isArray(record.additionalProperty) ? record.additionalProperty : [];
  const attributes = additionalProperties.map((item) => {
    const property = asRecord(item) || {};
    const label = clean(property.name, 30);
    const value = clean(property.value, 50);
    return label && value ? `${label}: ${value}` : "";
  }).filter(Boolean).slice(0, 5);
  const availability = clean(offers.availability, 80).toLowerCase();
  try { if (rawUrl) productUrl = new URL(rawUrl, baseUrl).toString(); } catch { /* ignore malformed URLs */ }
  try { if (rawImage) image = new URL(rawImage, baseUrl).toString(); } catch { /* ignore malformed URLs */ }
  return {
    id: `found-${index}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 28)}`,
    name,
    price: Number.isFinite(parsedPrice) ? parsedPrice : 0,
    currency: clean(offers.priceCurrency, 6) || "SGD",
    description: clean(record.description, 180) || "Available from the online store.",
    category: inferProductCategory(name, clean(record.category, 40)),
    ...(image ? { image } : {}),
    ...(productUrl ? { url: productUrl } : {}),
    ...(attributes.length ? { attributes } : {}),
    ...(availability ? { available: !/outofstock|soldout|discontinued/.test(availability) } : {}),
  };
}

function dedupeProducts(products: Product[]) {
  const quality = (product: Product) =>
    (product.price > 0 ? 4 : 0) +
    (product.image ? 3 : 0) +
    (product.url ? 1 : 0) +
    (!/^available from the online (store|shop)\.?$/i.test(product.description) ? 2 : 0) +
    (!/^(other products|store product)$/i.test(product.category) ? 1 : 0);
  const unique = new Map<string, Product>();
  for (const product of products) {
    if (product.name.length < 2) continue;
    let productLocation = "";
    try { productLocation = product.url ? new URL(product.url).pathname.toLowerCase().replace(/\/$/, "") : ""; } catch { /* ignore malformed product URLs */ }
    const key = productLocation || product.name.toLowerCase();
    const current = unique.get(key);
    if (!current || quality(product) > quality(current)) unique.set(key, product);
  }
  return [...unique.values()].slice(0, MAX_CATALOGUE_PRODUCTS);
}

function productsFromNikeData(value: unknown, baseUrl: URL): Product[] {
  const record = asRecord(value) || {};
  const groupings = Array.isArray(record.productGroupings) ? record.productGroupings : [];
  const products: Product[] = [];
  for (const groupingValue of groupings) {
    const grouping = asRecord(groupingValue) || {};
    const variants = (Array.isArray(grouping.products) ? grouping.products : [])
      .map((variant) => asRecord(variant))
      .filter((variant): variant is Record<string, unknown> => Boolean(variant));
    if (!variants.length) continue;

    const pricedVariants = variants.filter((variant) => {
      const prices = asRecord(variant.prices) || {};
      return Number(prices.currentPrice) > 0;
    });
    const representative = [...(pricedVariants.length ? pricedVariants : variants)].sort((a, b) => {
      const aPrice = Number((asRecord(a.prices) || {}).currentPrice) || Infinity;
      const bPrice = Number((asRecord(b.prices) || {}).currentPrice) || Infinity;
      return aPrice - bPrice;
    })[0];
    const copy = asRecord(representative.copy) || {};
    const prices = asRecord(representative.prices) || {};
    const pdpUrl = asRecord(representative.pdpUrl) || {};
    const images = asRecord(representative.colorwayImages) || {};
    const name = clean(copy.title, 130);
    const subtitle = clean(copy.subTitle, 100);
    if (!name) continue;

    const priceValues = variants
      .map((variant) => Number((asRecord(variant.prices) || {}).currentPrice))
      .filter((price) => Number.isFinite(price) && price > 0);
    const distinctPrices = [...new Set(priceValues)];
    const price = distinctPrices.length ? Math.min(...distinctPrices) : 0;
    const colours = [...new Set(variants.map((variant) => {
      const displayColours = asRecord(variant.displayColors) || {};
      return clean(displayColours.colorDescription, 80) || clean((asRecord(displayColours.simpleColor) || {}).label, 40);
    }).filter(Boolean))];
    const rawUrl = firstString(pdpUrl.url) || firstString(pdpUrl.path);
    let productUrl = "";
    try { if (rawUrl) productUrl = new URL(rawUrl, baseUrl).toString(); } catch { /* ignore malformed product URLs */ }
    const rawImage = firstString(images.squarishURL) || firstString(images.portraitURL);
    const descriptionParts = [subtitle];
    if (colours.length) descriptionParts.push(`${colours.length} colour${colours.length === 1 ? "" : "s"} listed`);

    products.push({
      id: `nike-${clean(grouping.groupKey ?? representative.groupKey ?? representative.productCode, 80) || products.length}`,
      name,
      price,
      currency: clean(prices.currency, 6) || "SGD",
      description: descriptionParts.filter(Boolean).join(". ") || "Available from Nike.",
      category: inferProductCategory(name, subtitle),
      ...(rawImage ? { image: rawImage } : {}),
      ...(productUrl ? { url: productUrl } : {}),
      ...(colours.length ? { attributes: [`Colours: ${colours.slice(0, 20).join(" | ")}`] } : {}),
      ...(distinctPrices.length > 1 ? { pricePrefix: "From " } : {}),
      available: true,
    });
  }
  return products;
}

function nikeWallFromHtml(html: string) {
  const nextData = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!nextData) return null;
  try {
    const data = asRecord(JSON.parse(nextData)) || {};
    const props = asRecord(data.props) || {};
    const pageProps = asRecord(props.pageProps) || {};
    const initialState = asRecord(pageProps.initialState) || {};
    return asRecord(initialState.Wall);
  } catch {
    return null;
  }
}

async function fetchNikeFeed(url: URL) {
  if (url.hostname !== "api.nike.com") throw new Error("Unexpected Nike catalogue host.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "nike-api-caller-id": "nike:dotcom:browse:wall.client:2.0",
        anonymousId: "unknown-anonymousid",
      },
    });
    if (!response.ok) throw new Error(`Nike catalogue returned ${response.status}.`);
    return asRecord(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverNikeCatalogue(baseUrl: URL) {
  const locale = baseUrl.pathname.split("/").filter(Boolean)[0] || "sg";
  const cacheKey = `${baseUrl.origin}/${locale}`;
  const cached = nikeCatalogueCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.products;

  const catalogueUrl = new URL(`/${locale}/w`, baseUrl.origin);
  const page = await fetchPublicPage(catalogueUrl, MAX_CATALOGUE_PAGE_BYTES);
  const wall = nikeWallFromHtml(page.html);
  if (!wall) return productsFromNikeData({}, catalogueUrl);

  const products = productsFromNikeData(wall, catalogueUrl);
  const pageData = asRecord(wall.pageData) || {};
  const nextPath = firstString(pageData.next);
  const totalResources = Math.min(Number(pageData.totalResources) || 0, MAX_CATALOGUE_PRODUCTS);
  if (nextPath && totalResources > 0) {
    const template = new URL(nextPath, "https://api.nike.com");
    template.searchParams.set("count", "100");
    const feedUrls: URL[] = [];
    for (let anchor = 0; anchor < totalResources; anchor += 100) {
      const feedUrl = new URL(template);
      feedUrl.searchParams.set("anchor", String(anchor));
      feedUrls.push(feedUrl);
    }
    for (let index = 0; index < feedUrls.length; index += 8) {
      const batch = await Promise.allSettled(feedUrls.slice(index, index + 8).map((feedUrl) => fetchNikeFeed(feedUrl)));
      for (const result of batch) {
        if (result.status === "fulfilled") products.push(...productsFromNikeData(result.value, catalogueUrl));
      }
    }
  }

  const catalogue = dedupeProducts(products);
  if (catalogue.length) nikeCatalogueCache.set(cacheKey, { expiresAt: Date.now() + 30 * 60_000, products: catalogue });
  return catalogue;
}

function productsFromRenderedCards(html: string, baseUrl: URL): Product[] {
  const products: Product[] = [];
  const cardPattern = /href=["'](?<url>\/product\/[^"'#]+)[^"']*["'][\s\S]{0,6000}?\$<\/span><h5[^>]*>(?<whole>[\d,]+)<\/h5><span[^>]*>\.<!-- -->(?<decimal>\d+)<\/span>[\s\S]{0,8000}?href=["']\k<url>[^"']*["']><p[^>]*>(?<name>[^<]+)<\/p>/gi;
  for (const match of html.matchAll(cardPattern)) {
    const groups = match.groups;
    if (!groups?.name || !groups.url) continue;
    const price = Number(`${groups.whole.replace(/,/g, "")}.${groups.decimal}`);
    products.push({
      id: `card-${groups.url.split("/").filter(Boolean).pop() || products.length}`,
      name: clean(groups.name, 130),
      price: Number.isFinite(price) ? price : 0,
      currency: "SGD",
      description: "Available from the online shop.",
      category: inferProductCategory(clean(groups.name, 130)),
      url: new URL(groups.url, baseUrl).toString(),
    });
  }
  return products;
}

function decodedScriptString(value: string) {
  try { return JSON.parse(`"${value}"`) as string; } catch { return value.replace(/\\"/g, '"').replace(/\\n/g, " "); }
}

function priceFromText(value: string) {
  const text = clean(value, 120);
  const match = text.match(/(?:(S|US|A|NZ)\$|RM\s*)?([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const price = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(price) || price <= 0) return null;
  const marker = (match[1] || "S").toUpperCase();
  const currency = marker === "US" ? "USD" : marker === "A" ? "AUD" : marker === "NZ" ? "NZD" : /RM/i.test(match[0]) ? "MYR" : "SGD";
  return { price, currency };
}

function productsFromAppleStore(html: string, baseUrl: URL): Product[] {
  const products: Product[] = [];
  const addProduct = (nameValue: string, priceValue: string, urlValue: string, descriptionValue = "") => {
    const name = clean(decodedScriptString(nameValue), 130);
    const parsedPrice = priceFromText(decodedScriptString(priceValue));
    if (!name || !parsedPrice) return;
    let productUrl: string | undefined;
    try { productUrl = new URL(decodedScriptString(urlValue), baseUrl).toString(); } catch { /* ignore malformed URLs */ }
    products.push({
      id: `apple-${(productUrl || name).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(-70)}`,
      name,
      price: parsedPrice.price,
      currency: parsedPrice.currency,
      description: clean(decodedScriptString(descriptionValue), 180) || "Available from the Apple Store.",
      category: inferProductCategory(name),
      ...(productUrl ? { url: productUrl } : {}),
      available: true,
    });
  };

  const linkedCards = /<a\s+[^>]*href=["'](?<url>[^"']+)["'][^>]*>(?<content>[\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkedCards)) {
    const groups = match.groups;
    if (!groups?.url || !groups.content || !/rf-(?:h|c)card-content-(?:title|header)/i.test(groups.content)) continue;
    const name = groups.content.match(/class=["'][^"']*rf-(?:hcard-content-title|ccard-content-header)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    const price = groups.content.match(/class=["'][^"']*rf-(?:hcard-scrim-price|ccard-content-descprice)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span)>/i)?.[1];
    if (name && price) addProduct(name, price, groups.url);
  }

  const accessoryData = /"priceData":"(?<whole>\d+)_(?<decimal>\d+)_fp_data"[\s\S]{0,2600}?"productDetailsUrl":"(?<url>(?:\\.|[^"\\])+)"[\s\S]{0,1200}?"title":"(?<name>(?:\\.|[^"\\])+)"/gi;
  for (const match of html.matchAll(accessoryData)) {
    const groups = match.groups;
    if (!groups?.name || !groups.url || !groups.whole || groups.decimal === undefined) continue;
    addProduct(groups.name, `S$${groups.whole}.${groups.decimal}`, groups.url);
  }
  return products;
}

function productsFromHtml(html: string, baseUrl: URL) {
  const rawProducts: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectProducts(JSON.parse(match[1]), rawProducts); } catch { /* malformed JSON-LD is common */ }
  }
  const products = rawProducts
    .map((record, index) => productFromJsonLd(record, index, baseUrl))
    .filter((product): product is Product => Boolean(product));
  products.push(...productsFromRenderedCards(html, baseUrl));
  products.push(...productsFromAppleStore(html, baseUrl));

  if (!products.length) {
    const name = metaContent(html, "og:title");
    const rawPrice = metaContent(html, "product:price:amount");
    const price = Number(rawPrice.replace(/[^0-9.]/g, ""));
    if (name && Number.isFinite(price) && price > 0) {
      products.push({
        id: `meta-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 32)}`,
        name,
        price,
        currency: metaContent(html, "product:price:currency") || "SGD",
        description: metaContent(html, "og:description") || "Available from the online store.",
        category: inferProductCategory(name),
        image: metaContent(html, "og:image") || undefined,
        url: baseUrl.toString(),
      });
    }
  }
  return products;
}

function productsFromShopifyJson(text: string, baseUrl: URL): Product[] {
  try {
    const data = JSON.parse(text) as { products?: Array<Record<string, unknown>> };
    return (data.products || []).map((record, index) => {
      const variants = (Array.isArray(record.variants) ? record.variants : []).map((item) => asRecord(item) || {});
      const availableVariants = variants.filter((item) => item.available !== false);
      const variant = availableVariants[0] || variants[0] || {};
      const images = Array.isArray(record.images) ? record.images : [];
      const imageRecord = asRecord(images[0]) || {};
      const price = Number(String(variant.price ?? "").replace(/[^0-9.]/g, ""));
      const options = Array.isArray(record.options) ? record.options : [];
      const attributes = options.map((item, optionIndex) => {
        const option = asRecord(item) || {};
        const label = clean(option.name, 30);
        const availableValues = availableVariants
          .map((availableVariant) => clean(availableVariant[`option${optionIndex + 1}`], 40))
          .filter((value, valueIndex, all) => Boolean(value) && !/^default title$/i.test(value) && all.indexOf(value) === valueIndex);
        const declaredValues = Array.isArray(option.values)
          ? option.values.map((value) => clean(value, 40)).filter((value) => Boolean(value) && !/^default title$/i.test(value))
          : [];
        const values = availableValues.length ? availableValues : declaredValues;
        return label && values.length ? `${label}: ${values.slice(0, 12).join(" | ")}` : "";
      }).filter(Boolean).slice(0, 5);
      return {
        id: `shopify-${record.id ?? index}`,
        name: clean(record.title, 100),
        price: Number.isFinite(price) ? price : 0,
        currency: "SGD",
        description: clean(record.body_html, 180) || "Available from the online store.",
        category: inferProductCategory(clean(record.title, 100), clean(record.product_type, 40)),
        image: firstString(imageRecord.src) || undefined,
        url: typeof record.handle === "string" ? new URL(`/products/${record.handle}`, baseUrl).toString() : undefined,
        attributes: attributes.length ? attributes : undefined,
        available: variants.length ? availableVariants.length > 0 : true,
      };
    });
  } catch {
    return [];
  }
}

function productsFromWooJson(text: string): Product[] {
  try {
    const data = JSON.parse(text) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return [];
    return data.map((record, index) => {
      const prices = asRecord(record.prices) || {};
      const minorUnit = Number(prices.currency_minor_unit ?? 2);
      const divisor = 10 ** (Number.isFinite(minorUnit) ? minorUnit : 2);
      const price = Number(prices.price ?? 0) / divisor;
      const categories = Array.isArray(record.categories) ? record.categories : [];
      const category = asRecord(categories[0]) || {};
      const images = Array.isArray(record.images) ? record.images : [];
      const image = asRecord(images[0]) || {};
      const rawAttributes = Array.isArray(record.attributes) ? record.attributes : [];
      const attributes = rawAttributes.map((item) => {
        const attribute = asRecord(item) || {};
        const label = clean(attribute.name, 30);
        const terms = Array.isArray(attribute.terms) ? attribute.terms : [];
        const values = terms.map((term) => clean(asRecord(term)?.name, 30)).filter(Boolean);
        return label && values.length ? `${label}: ${values.slice(0, 12).join(" | ")}` : "";
      }).filter(Boolean).slice(0, 5);
      return {
        id: `woo-${record.id ?? index}`,
        name: clean(record.name, 100),
        price: Number.isFinite(price) ? price : 0,
        currency: clean(prices.currency_code, 6) || "SGD",
        description: clean(record.short_description ?? record.description, 180) || "Available from the online store.",
        category: inferProductCategory(clean(record.name, 100), clean(category.name, 40)),
        image: firstString(image.src) || undefined,
        url: firstString(record.permalink) || undefined,
        attributes: attributes.length ? attributes : undefined,
        available: record.is_in_stock !== false,
      };
    });
  } catch {
    return [];
  }
}

async function fetchShopifyCatalogue(baseUrl: URL) {
  const products: Product[] = [];
  for (let pageNumber = 1; pageNumber <= 20 && products.length < MAX_CATALOGUE_PRODUCTS; pageNumber += 1) {
    try {
      const page = await fetchPublicPage(new URL(`/products.json?limit=250&page=${pageNumber}`, baseUrl), MAX_CATALOGUE_PAGE_BYTES);
      const batch = productsFromShopifyJson(page.html, baseUrl);
      if (!batch.length) break;
      products.push(...batch);
      if (batch.length < 250) break;
    } catch (error) {
      console.warn("[api/analyze] Shopify catalogue page failed.", {
        domain: baseUrl.hostname,
        pageNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return products;
}

async function fetchWooCatalogue(baseUrl: URL) {
  const products: Product[] = [];
  for (let pageNumber = 1; pageNumber <= 50 && products.length < MAX_CATALOGUE_PRODUCTS; pageNumber += 1) {
    try {
      const page = await fetchPublicPage(new URL(`/wp-json/wc/store/v1/products?per_page=100&page=${pageNumber}`, baseUrl), MAX_CATALOGUE_PAGE_BYTES);
      const batch = productsFromWooJson(page.html);
      if (!batch.length) break;
      products.push(...batch);
      if (batch.length < 100) break;
    } catch (error) {
      console.warn("[api/analyze] WooCommerce catalogue page failed.", {
        domain: baseUrl.hostname,
        pageNumber,
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return products;
}

function registrableDomain(hostname: string) {
  const labels = hostname.toLowerCase().replace(/^www\./, "").split(".");
  const commonSecondLevels = new Set(["co.uk", "com.au", "com.sg", "com.my", "co.nz", "co.jp", "com.hk"]);
  const lastTwo = labels.slice(-2).join(".");
  return commonSecondLevels.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

function storeLinks(html: string, baseUrl: URL) {
  const candidates = new Map<string, number>();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const href = match[1].replace(/&amp;/gi, "&");
      const url = new URL(href, baseUrl);
      if (registrableDomain(url.hostname) !== registrableDomain(baseUrl.hostname) || !/^https?:$/.test(url.protocol)) continue;
      if (/cart|checkout|account|login|wishlist|privacy|terms/i.test(url.pathname)) continue;
      let score = 0;
      if (/\/shop\/(?:go|goto)\/(?:store|shop)(?:\/|$)/i.test(url.pathname)) score = 7;
      else if (/\/shop\/(?:go|goto)\/buy[_-]/i.test(url.pathname)) score = 6;
      else if (/\/shop\/(?:buy-|accessories)(?:\/|$)/i.test(url.pathname)) score = 6;
      else if (/^(shop|store)\./i.test(url.hostname)) score = 5;
      else if (/\/products?\//i.test(url.pathname)) score = 4;
      else if (/\/collections?\//i.test(url.pathname)) score = 3;
      else if (/\/(shop|catalog|store)(\/|$)/i.test(url.pathname)) score = 2;
      if (score) candidates.set(url.toString(), Math.max(score, candidates.get(url.toString()) || 0));
    } catch { /* ignore malformed links */ }
  }
  if (/(?:^|\.)apple\.com$/i.test(baseUrl.hostname)) {
    const firstSegment = baseUrl.pathname.split("/").filter(Boolean)[0] || "";
    const localePrefix = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(firstSegment) ? `/${firstSegment}` : "";
    candidates.set(new URL(`${localePrefix}/store`, baseUrl.origin).toString(), 10);
  }
  return [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_DISCOVERY_PAGES).map(([url]) => new URL(url));
}

async function discoverProducts(rootHtml: string, baseUrl: URL) {
  const found = productsFromHtml(rootHtml, baseUrl);
  const linkedPages = storeLinks(rootHtml, baseUrl);
  const relatedStorefronts = linkedPages.filter((url) => url.hostname !== baseUrl.hostname || /\/(shop|store|catalog)(\/|$)/i.test(url.pathname)).slice(0, 2);
  const catalogueOrigins = [baseUrl, ...relatedStorefronts]
    .filter((url, index, all) => all.findIndex((item) => item.origin === url.origin) === index);

  const [catalogues, primaryPages] = await Promise.all([
    Promise.allSettled(catalogueOrigins.flatMap((origin) => [fetchShopifyCatalogue(origin), fetchWooCatalogue(origin)])),
    Promise.allSettled(linkedPages.slice(0, MAX_DISCOVERY_PAGES).map((url) => fetchPublicPage(url))),
  ]);

  for (const result of catalogues) {
    if (result.status === "fulfilled") found.push(...result.value);
  }
  const visited = new Set(linkedPages.map((url) => url.toString()));
  const secondaryLinks: URL[] = [];
  for (const result of primaryPages) {
    if (result.status !== "fulfilled") continue;
    found.push(...productsFromHtml(result.value.html, result.value.finalUrl));
    for (const link of storeLinks(result.value.html, result.value.finalUrl)) {
      if (visited.has(link.toString())) continue;
      visited.add(link.toString());
      secondaryLinks.push(link);
    }
  }
  const secondaryPages = await Promise.allSettled(secondaryLinks.slice(0, MAX_DISCOVERY_PAGES).map((url) => fetchPublicPage(url)));
  for (const result of secondaryPages) {
    if (result.status === "fulfilled") found.push(...productsFromHtml(result.value.html, result.value.finalUrl));
  }
  return dedupeProducts(found);
}

async function discoverGenericCatalogue(rootHtml: string, baseUrl: URL) {
  const cacheKey = baseUrl.origin;
  const cached = genericCatalogueCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.products;

  const pending = genericCatalogueRequests.get(cacheKey);
  if (pending) return pending;

  const request = (async () => {
    let products: Product[] = [];
    if (rootHtml) {
      products = await discoverProducts(rootHtml, baseUrl);
    } else {
      const feeds = await Promise.allSettled([
        fetchShopifyCatalogue(baseUrl),
        fetchWooCatalogue(baseUrl),
      ]);
      for (const feed of feeds) {
        if (feed.status === "fulfilled") products.push(...feed.value);
      }
      products = dedupeProducts(products);
    }

    if (products.length) {
      genericCatalogueCache.set(cacheKey, {
        expiresAt: Date.now() + 30 * 60_000,
        staleUntil: Date.now() + 24 * 60 * 60_000,
        products,
      });
      return products;
    }
    if (cached && cached.staleUntil > Date.now()) return cached.products;
    return [];
  })().finally(() => genericCatalogueRequests.delete(cacheKey));

  genericCatalogueRequests.set(cacheKey, request);
  return request;
}

async function discoverAppleCatalogue(baseUrl: URL) {
  const firstSegment = baseUrl.pathname.split("/").filter(Boolean)[0] || "";
  const localePrefix = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(firstSegment) ? `/${firstSegment}` : "";
  const cacheKey = `${baseUrl.origin}${localePrefix || "/"}`;
  const cached = appleCatalogueCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.products;

  const paths = [
    `${localePrefix}/store`,
    `${localePrefix}/shop/buy-mac`,
    `${localePrefix}/shop/buy-iphone`,
    `${localePrefix}/shop/buy-ipad`,
    `${localePrefix}/shop/buy-watch`,
    `${localePrefix}/shop/buy-airpods`,
    `${localePrefix}/shop/accessories/all`,
    `${localePrefix}/mac/`,
    `${localePrefix}/iphone/`,
    `${localePrefix}/ipad/`,
    `${localePrefix}/watch/`,
    `${localePrefix}/airpods/`,
  ];
  const products: Product[] = [];
  const pages = await Promise.allSettled(
    paths.map((path) => fetchPublicPage(new URL(path, baseUrl.origin))),
  );
  for (const page of pages) {
    if (page.status === "fulfilled") {
      products.push(...productsFromHtml(page.value.html, page.value.finalUrl));
    }
  }
  const catalogue = dedupeProducts(products);
  if (catalogue.length) appleCatalogueCache.set(cacheKey, { expiresAt: Date.now() + 30 * 60_000, products: catalogue });
  return catalogue;
}

function sampleCatalogue(vertical: string): Product[] {
  const samples: Record<string, Omit<Product, "id">[]> = {
    kitchen: [
      { name: "Nordic Pro Frypan", price: 69.9, currency: "SGD", description: "28cm non-stick frypan, PFOA-free and induction ready.", category: "Cookware" },
      { name: "Glass Pantry Set", price: 34.5, currency: "SGD", description: "Six airtight stackable glass containers.", category: "Kitchen storage" },
      { name: "Everyday Chef Knife", price: 48, currency: "SGD", description: "Balanced 8-inch stainless steel kitchen knife.", category: "Kitchen tools" },
    ],
    fashion: [
      { name: "Linen Weekend Shirt", price: 59, currency: "SGD", description: "Relaxed-fit breathable linen blend shirt.", category: "Apparel" },
      { name: "Everyday Canvas Tote", price: 32, currency: "SGD", description: "Structured carry-all with an inner pocket.", category: "Bags" },
      { name: "Classic Court Sneaker", price: 79, currency: "SGD", description: "Low-profile everyday sneaker with cushioned sole.", category: "Footwear" },
    ],
    beauty: [
      { name: "Daily Dew Serum", price: 42, currency: "SGD", description: "Lightweight hydrating serum with niacinamide.", category: "Skincare" },
      { name: "Cloud Cleanser", price: 28, currency: "SGD", description: "Gentle pH-balanced foaming face wash.", category: "Skincare" },
      { name: "Mineral Shield SPF50", price: 36, currency: "SGD", description: "Weightless daily sunscreen with no white cast.", category: "Sun care" },
    ],
    food: [
      { name: "House Blend Coffee", price: 18, currency: "SGD", description: "Chocolatey medium roast, 250g whole beans.", category: "Coffee" },
      { name: "Breakfast Discovery Box", price: 45, currency: "SGD", description: "A curated set of six customer favourites.", category: "Gift sets" },
      { name: "Sea Salt Sourdough", price: 12, currency: "SGD", description: "Slow-fermented artisan loaf baked fresh daily.", category: "Bakery" },
    ],
    tech: [
      { name: "Pocket Power 10K", price: 49, currency: "SGD", description: "Compact 10,000mAh USB-C fast-charge power bank.", category: "Accessories" },
      { name: "QuietType Keyboard", price: 78, currency: "SGD", description: "Low-profile wireless keyboard for two devices.", category: "Computer accessories" },
      { name: "Mini Desk Speaker", price: 65, currency: "SGD", description: "Clear, room-filling audio in a compact body.", category: "Audio" },
    ],
    general: [
      { name: "Everyday Essential", price: 39.9, currency: "SGD", description: "A practical customer favourite for everyday use.", category: "Bestsellers" },
      { name: "Premium Gift Set", price: 68, currency: "SGD", description: "A ready-to-gift selection of signature items.", category: "Gifts" },
      { name: "Starter Bundle", price: 49, currency: "SGD", description: "A simple bundle for first-time customers.", category: "Bundles" },
    ],
  };
  return (samples[vertical] || samples.general).map((product, index) => ({ ...product, id: `sample-${index + 1}` }));
}

function inferVertical(text: string) {
  const value = text.toLowerCase();
  if (/kitchen|cookware|homeware|furniture|interior/.test(value)) return "kitchen";
  if (/fashion|apparel|shirt|dress|shoe|clothing|boutique/.test(value)) return "fashion";
  if (/beauty|skin|cosmetic|serum|wellness|spa/.test(value)) return "beauty";
  if (/coffee|food|bakery|restaurant|cafe|grocery/.test(value)) return "food";
  if (/tech|electronic|computer|gadget|audio|phone/.test(value)) return "tech";
  return "general";
}

function demoProfile(url: URL) {
  return {
    name: "Harbour Supply",
    url: url.toString(),
    domain: url.hostname,
    summary: "Modern kitchen and home essentials for practical everyday living.",
    vertical: "kitchen",
    accent: "#0a6d48",
    products: sampleCatalogue("kitchen"),
    policies: ["Islandwide delivery", "30-day returns", "Secure checkout"],
    sourceStatus: "sample" as const,
    sourceNote: "Sample catalogue loaded for a quick walkthrough.",
  };
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as { url?: string };
    const url = safeUrl(payload.url?.trim() || "");
    if (url.hostname === "demo.hi-lite.store") return Response.json({ profile: demoProfile(url) });

    let html = "";
    let finalUrl = url;
    let readError = "";
    try {
      const page = await fetchPublicPage(url);
      html = page.html;
      finalUrl = page.finalUrl;
    } catch (error) {
      readError = error instanceof Error ? error.message : "The store blocked the preview reader.";
      console.warn("[api/analyze] Store page unavailable; trying catalogue feeds directly.", { domain: url.hostname, readError });
    }

    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const siteName = metaContent(html, "og:site_name");
    const pageTitle = clean(titleMatch?.[1] || "", 100).split(/[|–—]/)[0].trim();
    const name = siteName || pageTitle || titleFromHost(finalUrl.hostname);
    const description = metaContent(html, "og:description") || metaContent(html, "description");
    const textSample = clean(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " "), 2400);
    const vertical = inferVertical(`${name} ${description} ${textSample}`);

    const isAppleStore = /(?:^|\.)apple\.com$/i.test(finalUrl.hostname);
    const isNikeStore = /(?:^|\.)nike\.com$/i.test(finalUrl.hostname);
    const products = isAppleStore
      ? await discoverAppleCatalogue(finalUrl)
      : isNikeStore
        ? await discoverNikeCatalogue(finalUrl)
        : await discoverGenericCatalogue(html, finalUrl);

    const hasLiveProducts = products.length > 0;
    console.info("[api/analyze] Catalogue prepared.", { domain: finalUrl.hostname, productCount: products.length, pageReadable: Boolean(html) });
    const themeColor = metaContent(html, "theme-color");
    const validAccent = /^#[0-9a-f]{6}$/i.test(themeColor) ? themeColor : "#0a6d48";
    return Response.json({
      profile: {
        name,
        url: finalUrl.toString(),
        domain: finalUrl.hostname,
        summary: description || `${name} is now ready for a tailored WhatsApp sales walkthrough.`,
        vertical,
        accent: validAccent,
        products: hasLiveProducts ? products : [],
        policies: ["Delivery questions", "Returns & exchanges", "Product recommendations"],
        sourceStatus: hasLiveProducts ? "live" : html ? "partial" : "fallback",
        sourceNote: hasLiveProducts
          ? `${products.length} products found in the store catalogue.`
          : html
            ? "The store profile was read, but its live catalogue was not available. Add or paste catalogue items before presenting this store."
            : `${readError} Add or paste catalogue items before presenting this store.`,
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Please enter a valid online store link." },
      { status: 400 },
    );
  }
}
