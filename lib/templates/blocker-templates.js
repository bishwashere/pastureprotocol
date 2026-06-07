import { TASK_LABELS } from '../tasks.js';

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAny(text, terms = []) {
  const haystack = normalizeText(text);
  return terms.some((term) => haystack.includes(normalizeText(term)));
}

function summarize(text, max = 360) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

export const BLOCKER_TEMPLATES = [
  {
    id: 'digital-product-growth',
    name: 'Digital Product Growth',
    appliesWhen: [
      'customer base',
      'customers',
      'users',
      'signups',
      'signup',
      'conversion',
      'retention',
      'churn',
      'onboarding',
      'saas',
      'app',
      'digital product',
      'subscription',
    ],
    blockers: [
      {
        id: 'customer-segment',
        title: 'Confirm target customer segment and growth goal',
        ask: 'Who is the ideal customer, and what should improve: signups, activation, retention, revenue, or referrals?',
        signals: ['icp', 'ideal customer', 'persona', 'segment', 'target customer', 'growth goal'],
      },
      {
        id: 'product-data',
        title: 'Provide read-only product/customer data access',
        ask: 'Share a MongoDB URI, warehouse access, or export with users, accounts, onboarding state, and key product events.',
        signals: ['mongodb', 'mongo', 'database', 'warehouse', 'users collection', 'accounts collection', 'product events'],
      },
      {
        id: 'analytics',
        title: 'Provide analytics/funnel access',
        ask: 'Share PostHog, GA, Mixpanel, Amplitude, or equivalent funnel/event analytics access or exports.',
        signals: ['posthog', 'google analytics', 'ga4', 'mixpanel', 'amplitude', 'analytics', 'funnel'],
      },
      {
        id: 'billing',
        title: 'Provide billing and revenue context',
        ask: 'Share Stripe, Paddle, Lemon Squeezy, MRR, subscription, plan, upgrade, downgrade, and churn data.',
        signals: ['stripe', 'paddle', 'lemon squeezy', 'billing', 'mrr', 'subscription', 'revenue', 'churn'],
      },
      {
        id: 'feedback',
        title: 'Provide customer feedback/support sources',
        ask: 'Share support inbox, Intercom, Crisp, reviews, survey responses, churn notes, or interview notes.',
        signals: ['intercom', 'crisp', 'zendesk', 'support', 'reviews', 'survey', 'feedback', 'interviews'],
      },
    ],
  },
  {
    id: 'ecommerce-growth',
    name: 'Ecommerce Growth',
    appliesWhen: [
      'ecommerce',
      'e-commerce',
      'shopify',
      'woocommerce',
      'online store',
      'cart',
      'checkout',
      'orders',
      'products',
    ],
    blockers: [
      {
        id: 'store-platform',
        title: 'Provide ecommerce platform access or export',
        ask: 'Share Shopify, WooCommerce, or store admin access/export for products, orders, carts, and customers.',
        signals: ['shopify', 'woocommerce', 'store admin', 'orders export', 'products export'],
      },
      {
        id: 'traffic-ads',
        title: 'Provide traffic and paid acquisition data',
        ask: 'Share GA4, ad accounts, campaign reports, attribution exports, or channel-level traffic data.',
        signals: ['ga4', 'google analytics', 'meta ads', 'google ads', 'tiktok ads', 'campaign', 'attribution'],
      },
      {
        id: 'catalog-margin',
        title: 'Provide catalog, margin, and inventory constraints',
        ask: 'Which products have margin, supply, inventory, shipping, or return-rate constraints?',
        signals: ['margin', 'inventory', 'stock', 'shipping', 'returns', 'cogs'],
      },
      {
        id: 'email-promos',
        title: 'Provide email/SMS and promotion history',
        ask: 'Share Klaviyo, Mailchimp, SMS, discount, campaign, or promotion performance data.',
        signals: ['klaviyo', 'mailchimp', 'sms', 'discount', 'promotion', 'coupon', 'email list'],
      },
    ],
  },
  {
    id: 'physical-local-business',
    name: 'Physical or Local Business',
    appliesWhen: [
      'physical store',
      'local business',
      'restaurant',
      'clinic',
      'salon',
      'retail',
      'foot traffic',
      'bookings',
      'appointments',
      'walk ins',
    ],
    blockers: [
      {
        id: 'location-offer',
        title: 'Confirm location, offer, and service area',
        ask: 'What locations, service area, hours, top offers, and customer types should growth focus on?',
        signals: ['location', 'service area', 'hours', 'offer', 'menu', 'services'],
      },
      {
        id: 'pos-sales',
        title: 'Provide POS, booking, or sales export',
        ask: 'Share POS, booking, appointment, transaction, foot-traffic, or customer-count data.',
        signals: ['pos', 'square', 'toast', 'clover', 'booking', 'appointments', 'sales export', 'foot traffic'],
      },
      {
        id: 'local-presence',
        title: 'Provide local listings and review access',
        ask: 'Share Google Business Profile, Yelp, review sites, local SEO, or map listing access/exports.',
        signals: ['google business', 'yelp', 'reviews', 'local seo', 'maps listing'],
      },
      {
        id: 'capacity',
        title: 'Confirm operational capacity and constraints',
        ask: 'What limits growth right now: staffing, seats, appointments, inventory, margin, or delivery capacity?',
        signals: ['capacity', 'staffing', 'seats', 'appointments', 'inventory', 'margin', 'delivery'],
      },
    ],
  },
  {
    id: 'b2b-sales-pipeline',
    name: 'B2B Sales Pipeline',
    appliesWhen: [
      'b2b',
      'enterprise',
      'pipeline',
      'leads',
      'sales',
      'demos',
      'crm',
      'accounts',
      'prospects',
    ],
    blockers: [
      {
        id: 'icp',
        title: 'Confirm ICP and target account profile',
        ask: 'Which industries, company sizes, buyer roles, geographies, and pain points define the ideal account?',
        signals: ['icp', 'target account', 'buyer role', 'industry', 'company size'],
      },
      {
        id: 'crm',
        title: 'Provide CRM or pipeline export',
        ask: 'Share HubSpot, Salesforce, Pipedrive, Attio, Close, or a pipeline export with stages and outcomes.',
        signals: ['hubspot', 'salesforce', 'pipedrive', 'attio', 'close crm', 'crm', 'pipeline export'],
      },
      {
        id: 'sales-conversations',
        title: 'Provide sales conversation evidence',
        ask: 'Share demo notes, call recordings/transcripts, objections, lost-deal reasons, and customer discovery notes.',
        signals: ['demo notes', 'call recordings', 'transcripts', 'objections', 'lost deal', 'discovery notes'],
      },
      {
        id: 'pricing-conversion',
        title: 'Provide pricing and conversion-stage data',
        ask: 'Share pricing, plan packaging, deal sizes, conversion rates, cycle length, and handoff points.',
        signals: ['pricing', 'deal size', 'conversion rate', 'sales cycle', 'handoff'],
      },
    ],
  },
  {
    id: 'content-audience-growth',
    name: 'Content and Audience Growth',
    appliesWhen: [
      'newsletter',
      'blog',
      'youtube',
      'tiktok',
      'instagram',
      'linkedin',
      'creator',
      'audience',
      'content',
      'followers',
      'subscribers',
    ],
    blockers: [
      {
        id: 'channels',
        title: 'Provide channel handles and analytics access',
        ask: 'Share channel handles plus YouTube, TikTok, Instagram, LinkedIn, newsletter, or blog analytics access/exports.',
        signals: ['youtube analytics', 'tiktok analytics', 'instagram insights', 'linkedin analytics', 'newsletter analytics', 'substack'],
      },
      {
        id: 'audience',
        title: 'Confirm audience and positioning',
        ask: 'Who is the audience, what promise do they care about, and what should they do next?',
        signals: ['audience', 'positioning', 'persona', 'content pillars', 'promise'],
      },
      {
        id: 'content-history',
        title: 'Provide content archive and performance history',
        ask: 'Share top and bottom posts/videos/articles, publishing cadence, topics, hooks, and conversion outcomes.',
        signals: ['content archive', 'top posts', 'top videos', 'cadence', 'hooks', 'performance history'],
      },
      {
        id: 'monetization',
        title: 'Provide monetization or conversion context',
        ask: 'Share sponsor, product, subscription, lead magnet, affiliate, or sales conversion data.',
        signals: ['sponsor', 'subscription', 'lead magnet', 'affiliate', 'monetization', 'conversion'],
      },
    ],
  },
];

function templateScore(template, contextText) {
  return template.appliesWhen.reduce((score, term) => score + (hasAny(contextText, [term]) ? 1 : 0), 0);
}

function inferTemplate(userText, project = {}) {
  const contextText = [
    userText,
    project?.name,
    project?.description,
    project?.url,
    project?.setup_notes,
  ].filter(Boolean).join(' ');
  const scored = BLOCKER_TEMPLATES
    .map((template) => ({ template, score: templateScore(template, contextText) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length) return scored[0].template;

  if (/\b(grow|growth|improve|increase|customers?|users?|sales|revenue|retention|churn|conversion)\b/i.test(userText || '')) {
    return BLOCKER_TEMPLATES[0];
  }
  return null;
}

export function inferBlockerTemplateTasks(input = {}) {
  const project = input.project || {};
  const userText = String(input.userText || input.request || '').trim();
  const accessText = [
    project?.name,
    project?.description,
    project?.url,
    project?.setup_notes,
    input.knownContext,
    input.providedContext,
  ].filter(Boolean).join(' ');
  const template = input.templateId
    ? BLOCKER_TEMPLATES.find((row) => row.id === input.templateId)
    : inferTemplate(userText, project);
  if (!template) return { template: null, tasks: [] };

  const maxTasks = Math.max(1, Math.min(8, Number(input.maxTasks) || 5));
  const tasks = template.blockers
    .filter((blocker) => !hasAny(accessText, blocker.signals || []))
    .slice(0, maxTasks)
    .map((blocker) => ({
      id: `blocker-${template.id}-${blocker.id}`,
      title: blocker.title,
      status: 'blocked',
      progress: 0,
      assignee: 'user',
      labels: [TASK_LABELS.BLOCKER],
      source: 'blocker_template',
      type: 'user_input',
      description: summarize(blocker.ask, 400),
      expectedOutput: summarize(blocker.ask, 400),
    }));

  return {
    template: {
      id: template.id,
      name: template.name,
    },
    tasks,
  };
}

export function formatBlockerTemplatesForPrompt() {
  return BLOCKER_TEMPLATES
    .map((template) => `${template.name}: ${template.blockers.map((b) => b.title).join('; ')}`)
    .join(' | ');
}
