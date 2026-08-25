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
  summary: string;
  domain: string;
  products: Product[];
  policies: string[];
};

const TEAM_HANDOFF_REPLY =
  "I can help with products, recommendations, delivery and store questions. For this request, I’ll need to connect you with our team—would you like me to help you choose a product in the meantime?";

function money(product: Product) {
  if (!product.price || product.price <= 0) return "priced by quote";
  try {
    const price = new Intl.NumberFormat("en-SG", { style: "currency", currency: product.currency || "SGD" }).format(product.price);
    return `${product.pricePrefix || ""}${price}`;
  } catch {
    return `${product.pricePrefix || ""}$${product.price.toFixed(2)}`;
  }
}

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function budgetFrom(message: string) {
  const matches = [...message.matchAll(/(?:under|below|less than|max(?:imum)?|budget(?: is| of)?)(?:\s*(?:around|about|roughly|approximately|up to))?\s*(?:s(?:gd)?\s*)?\$?\s*([\d,]+(?:\.\d+)?)/gi)];
  const latestBudget = matches.at(-1)?.[1];
  return latestBudget ? Number(latestBudget.replace(/,/g, "")) : Infinity;
}

const COLOUR_TERMS = new Set([
  "black", "blue", "brown", "beige", "clear", "cobalt", "cream", "cyan", "gold", "gray", "green", "grey", "magenta", "maroon", "navy", "orange", "pink", "purple", "red", "silver", "teal", "transparent", "turquoise", "violet", "white", "yellow",
]);

const PRODUCT_TYPE_TERMS = new Set([
  "adapter", "adapters", "backpack", "backpacks", "bag", "bags", "book", "books", "bottle", "bottles", "case", "cases", "chair", "chairs", "charger", "chargers", "chromebook", "chromebooks", "computer", "computers", "cover", "covers", "desk", "desks", "dress", "dresses", "headset", "headsets", "hoodie", "hoodies", "ideapad", "ideapads", "jacket", "jackets", "jersey", "jerseys", "keyboard", "keyboards", "knife", "knives", "lamp", "lamps", "laptop", "laptops", "macbook", "macbooks", "marker", "markers", "monitor", "monitors", "mouse", "mice", "notebook", "notebooks", "pan", "pans", "pen", "pens", "pencil", "pencils", "phone", "phones", "printer", "printers", "rack", "racks", "shelf", "shelves", "shirt", "shirts", "shoe", "shoes", "shorts", "sleeve", "sleeves", "smartphone", "smartphones", "sofa", "sofas", "table", "tables", "tablet", "tablets", "trouser", "trousers", "wallet", "wallets",
]);

const DEVICE_PRODUCT_TYPES = new Set(["computer", "laptop", "monitor", "phone", "printer", "tablet"]);
const ACCESSORY_PRODUCT_TYPES = new Set(["adapter", "backpack", "bag", "case", "charger", "cover", "headset", "keyboard", "mouse", "sleeve"]);

function productSearchText(product: Product) {
  return normalise([product.name, product.category, product.description, ...(product.attributes || [])].join(" "));
}

function damerauLevenshtein(left: string, right: string) {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const distance = Array.from({ length: rows }, () => Array<number>(columns).fill(0));
  for (let row = 0; row < rows; row += 1) distance[row][0] = row;
  for (let column = 0; column < columns; column += 1) distance[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      distance[row][column] = Math.min(
        distance[row - 1][column] + 1,
        distance[row][column - 1] + 1,
        distance[row - 1][column - 1] + substitution,
      );
      if (
        row > 1 &&
        column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) {
        distance[row][column] = Math.min(distance[row][column], distance[row - 2][column - 2] + 1);
      }
    }
  }
  return distance[left.length][right.length];
}

function includesTerm(value: string, term: string) {
  if (value.includes(term) || (term.endsWith("s") && term.length > 3 && value.includes(term.slice(0, -1)))) return true;
  if (term.length < 5) return false;
  const threshold = term.length >= 6 ? 2 : 1;
  return normalise(value)
    .split(" ")
    .some((candidate) => Math.abs(candidate.length - term.length) <= threshold && damerauLevenshtein(candidate, term) <= threshold);
}

function colourOptions(product: Product) {
  const colourAttributes = (product.attributes || []).filter((attribute) => /^(?:colou?rs?|finish(?:es)?)\s*:/i.test(attribute));
  if (colourAttributes.length) {
    return colourAttributes.flatMap((attribute) => {
      const value = attribute.slice(attribute.indexOf(":") + 1);
      const separator = value.includes("|") ? /[|,;]/ : /[/,;]/;
      return value.split(separator).map(normalise).filter(Boolean);
    });
  }
  return normalise(product.name).split(" ").filter((term) => COLOUR_TERMS.has(term));
}

function requestedColours(message: string) {
  return [...new Set(normalise(message).split(" ").filter((term) => COLOUR_TERMS.has(term)))];
}

function supportsRequestedColours(product: Product, colours: string[]) {
  if (!colours.length) return true;
  const options = new Set(colourOptions(product));
  return colours.every((colour) => [...options].some((option) => option === colour || option.split(" ").includes(colour)));
}

const SINGULAR_PRODUCT_TYPES = new Map([
  ["adapters", "adapter"], ["backpacks", "backpack"], ["bags", "bag"], ["books", "book"], ["bottles", "bottle"], ["cases", "case"], ["chairs", "chair"], ["chargers", "charger"], ["chromebook", "laptop"], ["chromebooks", "laptop"], ["computers", "computer"], ["covers", "cover"], ["desks", "desk"],
  ["dresses", "dress"], ["hoodies", "hoodie"], ["jackets", "jacket"], ["jerseys", "jersey"],
  ["headsets", "headset"], ["ideapad", "laptop"], ["ideapads", "laptop"], ["keyboards", "keyboard"], ["knives", "knife"], ["lamps", "lamp"], ["laptops", "laptop"], ["macbook", "laptop"], ["macbooks", "laptop"], ["markers", "marker"], ["mice", "mouse"], ["monitors", "monitor"], ["notebooks", "notebook"], ["pans", "pan"],
  ["pens", "pen"], ["pencils", "pencil"], ["phones", "phone"], ["printers", "printer"], ["racks", "rack"], ["shelves", "shelf"], ["sleeves", "sleeve"], ["smartphone", "phone"], ["smartphones", "phone"], ["sofas", "sofa"],
  ["shirts", "shirt"], ["shoes", "shoe"], ["tables", "table"], ["tablets", "tablet"], ["trousers", "trouser"], ["wallets", "wallet"],
]);

function singularProductType(term: string) {
  return SINGULAR_PRODUCT_TYPES.get(term) || term;
}

function requestedProductTypes(message: string) {
  return [...new Set(normalise(message).split(" ").filter((term) => PRODUCT_TYPE_TERMS.has(term)).map(singularProductType))];
}

function supportsRequestedProductTypes(product: Product, types: string[]) {
  if (!types.length) return true;
  const primaryText = normalise(`${product.name} ${product.category}`);
  const primaryTypes = new Set(
    primaryText
      .split(" ")
      .filter((term) => PRODUCT_TYPE_TERMS.has(term))
      .map(singularProductType),
  );
  const descriptionTypes = new Set(
    normalise(product.description)
      .split(" ")
      .filter((term) => PRODUCT_TYPE_TERMS.has(term))
      .map(singularProductType),
  );
  const isAccessory = /\b(?:refill|replacement|ink cartridge|lead refill)\b/.test(primaryText);
  const requestedDevice = types.some((type) => DEVICE_PRODUCT_TYPES.has(type));
  const requestedAccessory = types.some((type) => ACCESSORY_PRODUCT_TYPES.has(type));
  const productAccessory = [...primaryTypes].some((type) => ACCESSORY_PRODUCT_TYPES.has(type));
  if (requestedDevice && productAccessory && !requestedAccessory) return false;
  return types.every((type) =>
    primaryTypes.has(type) || (!primaryTypes.size && !isAccessory && descriptionTypes.has(type)),
  );
}

function rememberedProductRequirements(message: string) {
  return normalise(message).split(" ").filter((term) => COLOUR_TERMS.has(term) || PRODUCT_TYPE_TERMS.has(term));
}

function isAlternativeAcceptance(message: string) {
  return /^(?:(?:sure|okay|ok|yes|yeah|yep)[,!.?\s-]*)?(?:what do you have|what else do you have|show me|show (?:me )?(?:the )?(?:alternatives|options)|what are (?:the )?(?:alternatives|options))\b/i.test(message.trim());
}

function selectedOptionFromHistory(message: string, history: { role: string; text: string }[]) {
  const selection = message.trim().match(/^(?:(?:i\s+)?(?:choose|pick|select)\s+)?(?:option\s*)?([1-6])(?:\s*please)?[.!]?$/i);
  if (!selection) return "";
  const optionNumber = selection[1];
  const lastOptions = [...history].reverse().find((entry) => entry.role === "bot" && /(?:^|\n)Option \d+:/i.test(entry.text));
  if (!lastOptions) return "";
  const option = lastOptions.text.match(new RegExp(`(?:^|\\n)Option ${optionNumber}:\\s*([^|\\n]+)`, "i"));
  return option?.[1]?.trim() || "";
}

function searchMessageWithMemory(message: string, history: { role: string; text: string }[] = []) {
  const selectedOption = selectedOptionFromHistory(message, history);
  if (selectedOption) return selectedOption;
  const compact = normalise(message);
  const lastAssistant = [...history].reverse().find((entry) => entry.role === "bot" && entry.text.trim())?.text || "";
  if (isAlternativeAcceptance(message) && /don(?:’|')t have an exact match|closest alternatives|not (?:currently )?available|unavailable/i.test(lastAssistant)) {
    const earlierRequest = [...history]
      .reverse()
      .find((entry) => entry.role === "customer" && normalise(entry.text) !== compact && rememberedProductRequirements(entry.text).length)?.text;
    const requirements = earlierRequest ? rememberedProductRequirements(earlierRequest) : [];
    if (requirements.length) return requirements.join(" ");
  }
  if (/which brand|what brand/i.test(lastAssistant) && compact.split(" ").length <= 3) {
    const earlierRequest = [...history]
      .reverse()
      .find((entry) => entry.role === "customer" && normalise(entry.text) !== compact && rememberedProductRequirements(entry.text).length)?.text;
    const requirements = earlierRequest ? rememberedProductRequirements(earlierRequest) : [];
    return [message, ...requirements].join(" ");
  }
  const isBudgetFollowUp = Number.isFinite(budgetFrom(message)) && requestedProductTypes(message).length === 0;
  const isFollowUp = isBudgetFollowUp || /^(?:yes|no|how much|what(?:'s| is) the price|what about|and the|is it|does it|can i|i want it|i(?:'ll| will) take it|that one|this one)\b/i.test(message.trim()) || /\b(?:it|that|this|one)\b/.test(compact);
  if (!isFollowUp) return message;
  const latestProductRequest = [...history]
    .reverse()
    .find((entry) => entry.role === "customer" && normalise(entry.text) !== compact && requestedProductTypes(entry.text).length)?.text;
  if (isBudgetFollowUp && latestProductRequest) return `${latestProductRequest} ${message}`;
  const priorNeeds = history
    .filter((entry) => entry.role === "customer" && entry.text.trim() && normalise(entry.text) !== compact)
    .slice(-3)
    .map((entry) => entry.text);
  return priorNeeds.length ? `${priorNeeds.join(" ")} ${message}` : message;
}

function rangeBrandClarification(message: string, matches: Product[], storeName = "") {
  if (!matches.length) return null;
  const messageTerms = new Set(normalise(message).split(" "));
  const leadingBrands = [...new Set(matches.map((product) => product.name.trim().split(/\s+/)[0]).filter(Boolean))];
  if (leadingBrands.length !== 1) return null;
  const brand = leadingBrands[0];
  if (normalise(storeName).includes(normalise(brand))) return null;
  if (messageTerms.has(normalise(brand))) return null;
  const range = [...messageTerms].find((term) =>
    term.length > 3 &&
    !COLOUR_TERMS.has(term) &&
    !PRODUCT_TYPE_TERMS.has(term) &&
    matches.every((product) => normalise(product.name).split(" ").includes(term)),
  );
  if (!range) return null;
  return { brand, range: range.charAt(0).toUpperCase() + range.slice(1) };
}

function rememberedRequirementLabel(message: string, history: { role: string; text: string }[]) {
  const compact = normalise(message);
  const previousRequest = [...history]
    .reverse()
    .find((entry) => entry.role === "customer" && normalise(entry.text) !== compact && rememberedProductRequirements(entry.text).length)?.text;
  const terms = previousRequest ? rememberedProductRequirements(previousRequest) : [];
  return terms.length ? terms.join(" ") : "item";
}

function requestedItemLabel(message: string) {
  const cleaned = message
    .replace(/^\s*(?:hi|hello|hey)\b[!,.:;\s-]*/i, "")
    .replace(/^\s*(?:(?:so|okay|ok|sure)[,!.?\s-]*)?(?:do you have|you have|have you got|is there|i(?:'m| am) looking for|i want(?: to buy)?|can i (?:buy|get))\s+/i, "")
    .replace(/^\s*(?:a|an|the)\s+/i, "")
    .replace(/[?!.]+$/g, "")
    .trim();
  return cleaned || "that exact item";
}

function productOptions(product: Product) {
  const options = (product.attributes || []).filter(Boolean).slice(0, 4);
  if (!options.length) return "";
  const parsed = options.map((option) => {
    const separator = option.indexOf(":");
    return separator > 0
      ? { key: option.slice(0, separator).trim().toLowerCase(), value: option.slice(separator + 1).trim() }
      : { key: "option", value: option.trim() };
  });
  const material = parsed.find(({ key }) => /material/.test(key))?.value;
  const finish = parsed.find(({ key }) => /colou?rs?|finish/.test(key))?.value;
  if (material && finish) return `It’s listed in ${material} with a ${finish} finish.`;
  if (material) return `The listed material is ${material}.`;
  if (finish) return `The listed colour or finish is ${finish}.`;
  return `Available options: ${options.join(", ")}.`;
}

function productDescription(product: Product) {
  const description = product.description.trim().replace(/\s+/g, " ");
  if (!description || /^(store product|available online)$/i.test(description)) return "";
  const firstSentence = description.match(/^.*?[.!?](?:\s|$)/)?.[0] || description;
  const concise = firstSentence.slice(0, 220).trim();
  return concise && !/[.!?]$/.test(concise) ? `${concise}.` : concise;
}

function pricingSentence(product: Product) {
  if (product.price > 0) return `The published price is ${money(product)}.`;
  return "This item is priced by quote, and I can help confirm the exact price for your chosen options.";
}

function relevantProducts(message: string, products: Product[], limit = 6) {
  const lower = message.toLowerCase();
  const budget = budgetFrom(message);
  const normalisedMessage = normalise(message);
  const ignored = new Set(["what", "which", "with", "that", "this", "have", "your", "you", "about", "need", "want", "show", "recommend", "anything", "something", "looking", "please", "under", "below", "for", "from", "the", "there", "does", "can", "could", "would", "carry", "sell", "stock", "available", "buy", "get", "order", "shop", "search", "find", "item", "product", "regular", "normal", "standard", "basic", "guys", "how", "much", "price", "cost", "yes", "yeah", "yep", "sure", "okay", "else", "other", "alternative", "alternatives", "option", "options", "and", "but", "then", "able", "are", "around", "based", "budget", "pain", "pains", "lower", "back", "within"]);
  const terms = lower.split(/[^a-z0-9]+/).filter((term) => term.length > 2 && !/^\d/.test(term) && !ignored.has(term));
  const needTerms = [
    ...(/\b(?:lower back|back pain|back pains|posture)\b/i.test(message) ? ["lumbar", "ergonomic", "support", "posture", "adjustable", "comfort"] : []),
    ...(/\b(?:long hours?|all day|extended use)\b/i.test(message) ? ["ergonomic", "support", "adjustable", "comfort"] : []),
  ];
  const colours = requestedColours(message);
  const productTypes = requestedProductTypes(message);
  const requiredTerms = terms.filter((term) => !COLOUR_TERMS.has(term) && !PRODUCT_TYPE_TERMS.has(term));
  const scored = products
    .filter((product) => product.available !== false)
    .filter((product) => !Number.isFinite(budget) || (product.price > 0 && product.price <= budget))
    .filter((product) => requiredTerms.every((term) => includesTerm(productSearchText(product), term)))
    .filter((product) => supportsRequestedColours(product, colours))
    .filter((product) => supportsRequestedProductTypes(product, productTypes))
    .map((product) => {
      const name = product.name.toLowerCase();
      const category = product.category.toLowerCase();
      const description = product.description.toLowerCase();
      const attributes = (product.attributes || []).join(" ").toLowerCase();
      const normalisedName = normalise(product.name);
      const exactPhraseScore = normalisedName.length >= 4 && normalisedMessage.includes(normalisedName) ? 14 : 0;
      const colourScore = colours.length ? 12 : 0;
      const unrequestedComplexity = !/(?:multi|mechanical|\b[2-9][ -]?colou?r)/.test(normalisedMessage) && /(?:multi|mechanical|\b[2-9][ -]?colou?r)/.test(normalisedName) ? 8 : 0;
      const needScore = needTerms.reduce((sum, term) => sum + (includesTerm(attributes, term) ? 4 : includesTerm(name, term) ? 3 : includesTerm(description, term) ? 3 : includesTerm(category, term) ? 2 : 0), 0);
      const semanticScore = exactPhraseScore + colourScore + needScore + terms.reduce((sum, term) => sum + (includesTerm(name, term) ? 4 : includesTerm(attributes, term) ? 3 : includesTerm(category, term) ? 2 : includesTerm(description, term) ? 1 : 0), 0) - unrequestedComplexity;
      const score = semanticScore + (Number.isFinite(budget) ? 0.25 : 0);
      return { product, score, semanticScore };
    })
    .sort((a, b) => b.score - a.score || (a.product.price > 0 ? a.product.price : Infinity) - (b.product.price > 0 ? b.product.price : Infinity));
  const bestSemanticScore = Math.max(0, ...scored.map((item) => item.semanticScore));
  const threshold = Math.max(2, bestSemanticScore * 0.7);
  return scored.filter((item) => bestSemanticScore ? item.semanticScore >= threshold : true).slice(0, limit).map((item) => item.product);
}

function catalogueRequestLabel(message: string) {
  const words = normalise(message).split(" ");
  const descriptors = words.filter((word) => COLOUR_TERMS.has(word) || ["business", "gaming", "portable", "student", "wireless"].includes(word));
  const types = requestedProductTypes(message);
  const filler = new Set(["able", "any", "anything", "are", "around", "available", "back", "based", "below", "budget", "buy", "can", "could", "demo", "do", "does", "exact", "few", "find", "for", "have", "how", "i", "is", "item", "looking", "lower", "max", "maximum", "me", "much", "need", "of", "one", "options", "pain", "pains", "please", "price", "product", "recommend", "sell", "sgd", "show", "some", "the", "there", "this", "to", "under", "want", "what", "which", "with", "you", "your"]);
  const meaningful = words.filter((word) =>
    word.length > 2 &&
    !/^\d/.test(word) &&
    !filler.has(word) &&
    !COLOUR_TERMS.has(word) &&
    !PRODUCT_TYPE_TERMS.has(word) &&
    !descriptors.includes(word),
  ).slice(-3);
  return [...new Set([...descriptors, ...meaningful, ...types])].join(" ") || "item";
}

function unavailableCatalogueReply(message: string, products: Product[]) {
  const types = requestedProductTypes(message);
  const budget = budgetFrom(message);
  const label = catalogueRequestLabel(message);
  const broaderMatches = types.length ? relevantProducts(types.join(" "), products, 6) : [];
  const budgetText = Number.isFinite(budget)
    ? ` under ${new Intl.NumberFormat("en-SG", { style: "currency", currency: "SGD", maximumFractionDigits: 0 }).format(budget)}`
    : "";
  const broaderType = types.find((type) => DEVICE_PRODUCT_TYPES.has(type)) || types.at(-1) || "item";
  const pluralType = broaderType.endsWith("s") ? broaderType : `${broaderType}s`;
  const alternative = broaderMatches.length
    ? ` The store does list other ${pluralType}—would you like to see those?`
    : "";
  return `I don’t have an exact match for “${label}${budgetText}” in the catalogue loaded for this demo, so I can’t confirm it’s available.${alternative}`;
}

function replySupportsProductCards(reply: string) {
  return !/couldn(?:'|’)t find|can(?:not|'t|’t) confirm|not listed|(?:isn|aren|wasn)(?:'|’)t listed|don(?:'|’)t have|no exact|unavailable|ask (?:our|the) store team|check available/i.test(reply);
}

function catalogueOverview(products: Product[]) {
  const categories = new Map<string, number>();
  let publishedPrices = 0;
  let quotePrices = 0;
  for (const product of products) {
    categories.set(product.category, (categories.get(product.category) || 0) + 1);
    if (product.price > 0) publishedPrices += 1;
    else quotePrices += 1;
  }
  return {
    totalProducts: products.length,
    publishedPrices,
    quotePrices,
    categories: [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => ({ name, count })),
  };
}

function isTooComplex(message: string, level: string) {
  const lower = message.toLowerCase();
  const hardBoundary = /lawsuit|legal advice|medical|diagnos|investment|hack|bypass|refund me now|chargeback|change my order|cancel my order|access my account|employee|supplier contract|wholesale agreement/.test(lower);
  if (hardBoundary) return true;
  const parts = message.split(/[?;]|\band\b/gi).filter((part) => part.trim()).length;
  const limit = level === "strict" ? 3 : level === "flexible" ? 12 : 7;
  return parts > limit || message.length > (level === "strict" ? 400 : level === "flexible" ? 2200 : 1000);
}

function localReply(message: string, profile: Profile, guardrail: string, history: { role: string; text: string }[] = []) {
  const lower = message.toLowerCase();
  if (isTooComplex(message, guardrail)) return { reply: TEAM_HANDOFF_REPLY, products: [], limited: true };
  if (/what (?:do )?(?:you|we)(?: guys)? sell|what products|what can i (?:buy|shop for)|show me what you have|browse/.test(lower)) {
    const categoryCounts = new Map<string, number>();
    for (const product of profile.products || []) categoryCounts.set(product.category, (categoryCounts.get(product.category) || 0) + 1);
    const categories = [...categoryCounts.entries()]
      .filter(([category]) => !/^(other products|store product)$/i.test(category))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([category]) => category);
    if (!categories.length) categories.push("a wide range of store products");
    const representatives = categories.map((category) => profile.products.find((product) => product.category === category)).filter((product): product is Product => Boolean(product)).slice(0, 4);
    return {
      reply: `We carry ${categories.join(", ")}${categories.length > 1 ? ", and more" : ""}. What are you looking for today?`,
      products: representatives,
      limited: false,
    };
  }
  if (/^(?:hi|hello|hey|good (?:morning|afternoon|evening))[!,.?\s]*$/.test(lower)) {
    return { reply: `Hi 👋 Welcome to ${profile.name}! What can I help you find today?`, products: [], limited: false };
  }
  if (/return|exchange|refund policy/.test(lower)) {
    return { reply: "I can help with returns and exchanges. Share your order number and what you’d like to return, and our team can review the next step with you.", products: [], limited: false };
  }
  if (/ship|delivery|deliver|postage/.test(lower)) {
    return { reply: "Yes, we can help with delivery. Share your postcode or destination and the item you’re interested in so I can guide you on the right next step.", products: [], limited: false };
  }
  if (/who are you|what can you do|help me/.test(lower)) {
    return { reply: `I’m ${profile.name}’s online sales assistant. I can show you products, exact published prices and options, compare the range, and help arrange a quote when an item is custom-priced. What are you looking for?`, products: [], limited: false };
  }
  if (/not (?:the )?(?:right )?brand|wrong brand|different brand|another brand/.test(lower)) {
    const rememberedItem = rememberedRequirementLabel(message, history);
    return { reply: `Got it—I won’t assume the brand. Which brand do you want for the ${rememberedItem}?`, products: [], limited: false };
  }
  const searchMessage = searchMessageWithMemory(message, history);
  const matches = relevantProducts(searchMessage, profile.products || []);
  const budget = budgetFrom(message);
  if (Number.isFinite(budget) && !matches.length) {
    return {
      reply: `I don’t have a product with a published price under $${budget.toFixed(budget % 1 ? 2 : 0)} in the online catalogue. Some items are custom-priced, so tell me what type of product you need and I can help request a quote that works with your budget.`,
      products: [],
      limited: false,
    };
  }
  if (/recommend|popular|best.?seller|where should i start|not sure/.test(lower) && !/under|below|budget|for my|need|looking/.test(lower)) {
    return {
      reply: "I found a few good places to start and listed each item with its price below. Is this for you or a gift, and what budget should I stay within?",
      products: matches,
      limited: false,
    };
  }
  if (/compare|difference|versus|\bvs\b/.test(lower) && matches.length > 1) {
    return {
      reply: `${matches[0].name} is ${money(matches[0])}. ${productDescription(matches[0])} ${matches[1].name} is ${money(matches[1])}. ${productDescription(matches[1])} Tell me which feature matters most and I’ll help you choose between them.`,
      products: matches.slice(0, 2),
      limited: false,
    };
  }
  if (/cheaper|less expensive|lower price|save money|too expensive/.test(lower) && matches.length) {
    const published = matches.filter((product) => product.price > 0).sort((a, b) => a.price - b.price);
    if (!published.length) {
      return { reply: "These options are priced by quote, so I can’t accurately call one cheaper yet. Tell me your budget and preferred material or finish, and I’ll help request the closest-priced option.", products: matches, limited: false };
    }
    const cheapest = published[0];
    return { reply: `Yes—${cheapest.name} is the lowest published-price match at ${money(cheapest)}. ${productDescription(cheapest)} Would that price point work better?`, products: [cheapest], limited: false };
  }
  if (matches.length) {
    const clarification = rangeBrandClarification(searchMessage, matches, profile.name);
    if (clarification) {
      const requirement = rememberedProductRequirements(searchMessage).join(" ") || "item";
      return {
        reply: `Just to clarify: ${clarification.range} is listed as a ${clarification.brand} range in this catalogue. Do you want the ${clarification.brand} ${clarification.range} ${requirement}, or are you looking for a different brand?`,
        products: [],
        limited: false,
      };
    }
    if (matches.length === 1) {
      const product = matches[0];
      return {
        reply: `Yes, we carry ${product.name}. ${productOptions(product)} ${productDescription(product)} ${pricingSentence(product)} Would you like help with this item or another option?`.replace(/\s+/g, " ").trim(),
        products: [product],
        limited: false,
      };
    }
    if (isAlternativeAcceptance(message)) {
      const requirement = rememberedRequirementLabel(message, history);
      return {
        reply: `Here are the closest ${requirement} alternatives available. I’ve listed each item and price below, with the closest match first. Would you like me to compare them?`,
        products: matches,
        limited: false,
      };
    }
    return {
      reply: `Yes—we have ${matches.length} matching options. I’ve listed each item and price below, with the closest match first. Would you like me to compare them?`,
      products: matches,
      limited: false,
    };
  }
  const requestedItem = requestedItemLabel(searchMessage);
  return { reply: `We don’t have an exact match for “${requestedItem}” in the current catalogue. I can show you the closest alternatives, but I won’t present a different item as the one you requested.`, products: [], limited: false };
}

async function n8nReply(webhookUrl: string, workflowKey: string | undefined, payload: Record<string, unknown>) {
  const url = new URL(webhookUrl);
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(url.hostname);
  const canUseLocalHttp = process.env.N8N_ALLOW_LOCALHOST === "true" && isLocalHost && url.protocol === "http:";
  if (url.protocol !== "https:" && !canUseLocalHttp) return null;
  if (!isLocalHost && /^(127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(workflowKey ? { "x-hi-lite-workflow-key": workflowKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    const reply = data.reply ?? data.message ?? data.output ?? data.text ?? data.response;
    return typeof reply === "string" && reply.trim() ? reply.trim().slice(0, 3000) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      message?: string;
      sessionId?: string;
      profile?: Profile;
      history?: { role: string; text: string }[];
      guardrail?: string;
    };
    const message = payload.message?.trim().slice(0, 3000) || "";
    if (!message || !payload.profile) return Response.json({ error: "A message and store profile are required." }, { status: 400 });

    const guardrail = payload.guardrail || "balanced";
    if (isTooComplex(message, guardrail)) return Response.json({ ...localReply(message, payload.profile, guardrail, payload.history), provider: "guardrail" });

    const recentHistory = (payload.history || []).slice(-10);
    const retrievalText = searchMessageWithMemory(message, recentHistory);
    const candidates = relevantProducts(retrievalText, payload.profile.products || [], 18);
    const isBrandCorrection = /not (?:the )?(?:right )?brand|wrong brand|different brand|another brand/i.test(message);
    if (!isBrandCorrection && requestedProductTypes(retrievalText).length && !candidates.length) {
      return Response.json({
        reply: unavailableCatalogueReply(retrievalText, payload.profile.products || []),
        products: [],
        limited: false,
        provider: "catalogue-guard",
      });
    }

    const configuredWebhook = typeof process !== "undefined" ? process.env.N8N_WEBHOOK_URL : undefined;
    if (configuredWebhook) {
      const reply = await n8nReply(configuredWebhook, process.env.N8N_WORKFLOW_KEY, {
        sessionId: payload.sessionId,
        customerMessage: message,
        business: { ...payload.profile, products: candidates },
        catalogueOverview: catalogueOverview(payload.profile.products || []),
        history: recentHistory,
        instructions: "Act as the store's warm, proactive online sales assistant and speak directly in the store's voice. Write like a real WhatsApp salesperson: warm, direct, conversational, and concise. Keep every reply to 32 words or fewer and usually 1 or 2 short sentences. Answer the question first. Avoid repeating canned openers such as 'Got it' on consecutive turns. Never use semicolon-heavy catalogue dumps or generic phrases such as 'based on what you told me' or 'I found matching options.' For a broad question such as 'what do you sell?', mention no more than four main categories, say there is more available, and ask one simple follow-up. Do not introduce yourself as a demo, bot, AI, or prototype. Only mention that this is a demo when an exact requested item cannot be confirmed from the loaded catalogue. Remember the customer's stated buying intent and the exact item, brand, colour, size, budget, use case, comfort needs, and other requirements from recent messages. For comfort-related needs such as back pain, recommend relevant catalogue features such as lumbar support, adjustability, and ergonomics without diagnosing, promising treatment, or giving medical advice. Product options are numbered as Option 1, Option 2, and Option 3 in the conversation history. When the customer replies with a number or says 'Option 2', treat that as selecting the corresponding item and confirm the chosen product by name and price. After a selection, offer product details, comparison, or a store-team handoff; never claim that this demo can reserve stock, add to cart, or complete checkout. Never drop the requested item when the customer adds a budget or another constraint. Never ask what they are shopping for when they have already said it. Correct obvious spelling mistakes in a requested brand or model only when the catalogue candidates clearly support that correction. Treat requested brand, model, colour, and size as required—not optional similarity hints. Do not treat a product range or model as the brand: when the catalogue title shows a different manufacturer or brand, explain the relationship and confirm which brand the customer wants before recommending. If the customer says the brand is wrong, keep the remembered product type and colour, ask for the intended brand, and return no product options until they answer. If the customer accepts an offer to see alternatives after an unavailable item, retain the requested product type, colour, size, and use, but drop the unavailable brand or model; never return unrelated catalogue items. If the supplied candidates do not contain every requested detail, clearly say the exact item is not available in the catalogue loaded for this demo instead of presenting a different product. Prefer an exact product-name and available-variant match over loosely related alternatives. Use the exact published catalogue price when it is greater than zero. If pricePrefix is 'From ', say the price starts from that amount rather than presenting it as a single fixed variant price. When the price is zero or missing, say the item is priced by quote and offer to help confirm the exact price—never invent a number. Product rows already show item names and prices, so do not repeat the list in the message. Mention material, colour, size, or finish only when it directly answers the question. Recommend only catalogue products, compare options, handle objections, and ask at most one useful follow-up. Never invent products, stock, policies, or order information. If the request needs account access, payment actions, or specialist judgment, offer a handoff to the store team.",
      });
      if (reply) return Response.json({ reply, products: replySupportsProductCards(reply) ? candidates.slice(0, 6) : [], limited: false, provider: "n8n" });
      if (process.env.N8N_REQUIRED !== "false") {
        return Response.json({ error: "The sales assistant is temporarily unavailable. Please try again in a moment." }, { status: 502 });
      }
    }

    return Response.json({ ...localReply(message, payload.profile, guardrail, payload.history), provider: "local" });
  } catch {
    return Response.json({ error: "The sales assistant could not answer that message." }, { status: 500 });
  }
}
