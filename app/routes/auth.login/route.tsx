import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import styles from "../_index/styles.module.css";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));
  return { errors };
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

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

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
            <span>Merchant access</span>
            <span className={styles.eyebrowDivider} />
            <span>Shopify OAuth</span>
          </div>
          <h1>
            Connect your Shopify store
            <span> securely.</span>
          </h1>
          <p className={styles.lead}>
            Enter your permanent <strong>*.myshopify.com</strong> domain to continue
            to AI-Buyense. Shopify handles authentication and app authorization.
          </p>
        </div>

        <aside className={styles.loginCard} aria-labelledby="login-title">
          <div className={styles.cardIcon}>
            <SearchIcon />
          </div>
          <p className={styles.cardEyebrow}>Shopify sign-in</p>
          <h2 id="login-title">Log in to AI-Buyense</h2>
          <p className={styles.cardDescription}>
            Use the Shopify domain of the store you want to manage.
          </p>

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
                value={shop}
                onChange={(event) => setShop(event.currentTarget.value)}
                required
                aria-describedby="shop-domain-help"
              />
            </div>
            <span id="shop-domain-help" className={styles.helpText}>
              Use your store&apos;s permanent <strong>*.myshopify.com</strong> domain.
            </span>

            {errors.shop ? (
              <div className={styles.unavailable} role="alert">
                {errors.shop}
              </div>
            ) : null}

            <button className={styles.button} type="submit">
              Continue with Shopify <ArrowIcon />
            </button>
          </form>

          <div className={styles.secureNote}>
            <span className={styles.lockIcon} aria-hidden="true">•</span>
            Secure authentication through Shopify OAuth
          </div>
        </aside>
      </section>
    </main>
  );
}
