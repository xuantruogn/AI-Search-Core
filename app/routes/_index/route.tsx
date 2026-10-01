import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m21 21-4.35-4.35m2.35-5.15a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M4 10h11m-4-4 4 4-4 4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m5 10 3 3 7-7" />
    </svg>
  );
}

const features = [
  {
    number: "01",
    title: "Understand shopper intent",
    description:
      "AI interprets meaning, attributes, context, and language to connect shoppers with products that actually fit what they need.",
  },
  {
    number: "02",
    title: "Keep your storefront experience",
    description:
      "Results are rendered with your existing Shopify theme so product cards, imagery, and storefront interactions remain consistent.",
  },
  {
    number: "03",
    title: "Operate with confidence",
    description:
      "Built-in quotas, analytics, background synchronization, and fallback behavior help keep search reliable in production.",
  },
];

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <main className={styles.page}>
      <div className={styles.glowOne} />
      <div className={styles.glowTwo} />

      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="AI-Buyense home">
          <span className={styles.brandMark}>
            <SearchIcon />
          </span>
          <span>AI-Buyense</span>
        </a>
        <div className={styles.headerBadge}>
          <span /> Built for Shopify stores
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>
            <span>AI Search</span>
            <span className={styles.eyebrowDivider} />
            <span>Native Theme Rendering</span>
          </div>
          <h1>
            Turn every search into
            <span> a better product discovery opportunity.</span>
          </h1>
          <p className={styles.lead}>
            AI-powered search for Shopify that understands natural language and
            returns relevant products while preserving your existing storefront experience.
          </p>

          <div className={styles.benefits}>
            <span><CheckIcon /> Semantic relevance</span>
            <span><CheckIcon /> Theme-compatible results</span>
            <span><CheckIcon /> Fast setup</span>
          </div>
        </div>

        <aside className={styles.loginCard} aria-labelledby="login-title">
          <div className={styles.cardIcon}>
            <SearchIcon />
          </div>
          <p className={styles.cardEyebrow}>Merchant access</p>
          <h2 id="login-title">Connect your store</h2>
          <p className={styles.cardDescription}>
            Enter your Shopify store domain to access the AI-Buyense admin.
          </p>

          {showForm ? (
            <form className={styles.form} method="post" action="/auth/login">
              <label className={styles.label} htmlFor="shop-domain">
                Shop domain
              </label>
              <div className={styles.inputWrap}>
                <span className={styles.inputPrefix} aria-hidden="true">S</span>
                <input
                  id="shop-domain"
                  className={styles.input}
                  type="text"
                  name="shop"
                  inputMode="url"
                  autoComplete="url"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="your-store.myshopify.com"
                  required
                  aria-describedby="shop-domain-help"
                />
              </div>
              <span id="shop-domain-help" className={styles.helpText}>
                Use your store&apos;s <strong>*.myshopify.com</strong> domain.
              </span>
              <button className={styles.button} type="submit">
                Continue with Shopify <ArrowIcon />
              </button>
            </form>
          ) : (
            <div className={styles.unavailable}>
              Shopify sign-in is currently unavailable. Please try again later.
            </div>
          )}

          <div className={styles.secureNote}>
            <span className={styles.lockIcon} aria-hidden="true">Ã¢â‚¬Â¢</span>
            Secure sign-in with Shopify OAuth
          </div>
        </aside>
      </section>

      <section className={styles.features} aria-label="Key capabilities">
        <div className={styles.featuresIntro}>
          <p>Why AI-Buyense?</p>
          <h2>Smarter search.<br />A more seamless shopping experience.</h2>
        </div>
        <div className={styles.featureGrid}>
          {features.map((feature) => (
            <article className={styles.featureCard} key={feature.number}>
              <span className={styles.featureNumber}>{feature.number}</span>
              <h3>{feature.title}</h3>
              <p>{feature.description}</p>
            </article>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <span>Ã‚Â© {new Date().getFullYear()} AI-Buyense</span>
        <span>Semantic commerce search for Shopify</span>
      </footer>
    </main>
  );
}
