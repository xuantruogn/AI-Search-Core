import type { LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";

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
    title: "Hiểu đúng ý định mua hàng",
    description:
      "AI phân tích ngữ nghĩa, thuộc tính và ngôn ngữ để đưa khách đến đúng sản phẩm họ thực sự cần.",
  },
  {
    number: "02",
    title: "Giữ nguyên giao diện của bạn",
    description:
      "Kết quả được render bằng chính product card của theme Shopify — đồng nhất từ hình ảnh đến quick add.",
  },
  {
    number: "03",
    title: "An toàn để vận hành",
    description:
      "Có quota, analytics, đồng bộ nền và cơ chế fallback về Shopify Search khi cần thiết.",
  },
];

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <main className={styles.page}>
      <div className={styles.glowOne} />
      <div className={styles.glowTwo} />

      <header className={styles.header}>
        <a className={styles.brand} href="/" aria-label="AI Buyense home">
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
            Biến mọi truy vấn thành
            <span> cơ hội mua hàng.</span>
          </h1>
          <p className={styles.lead}>
            Công cụ tìm kiếm AI dành cho Shopify, hiểu ngôn ngữ tự nhiên và
            hiển thị kết quả hoàn toàn đồng bộ với giao diện cửa hàng của bạn.
          </p>

          <div className={styles.benefits}>
            <span><CheckIcon /> Kết quả theo ngữ nghĩa</span>
            <span><CheckIcon /> Không phá vỡ theme</span>
            <span><CheckIcon /> Cài đặt nhanh chóng</span>
          </div>
        </div>

        <aside className={styles.loginCard} aria-labelledby="login-title">
          <div className={styles.cardIcon}>
            <SearchIcon />
          </div>
          <p className={styles.cardEyebrow}>Merchant access</p>
          <h2 id="login-title">Kết nối cửa hàng</h2>
          <p className={styles.cardDescription}>
            Nhập domain Shopify để truy cập trang quản trị AI Search.
          </p>

          {showForm ? (
            <Form className={styles.form} method="post" action="/auth/login">
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
                Sử dụng domain <strong>*.myshopify.com</strong> của cửa hàng.
              </span>
              <button className={styles.button} type="submit">
                Đăng nhập với Shopify <ArrowIcon />
              </button>
            </Form>
          ) : (
            <div className={styles.unavailable}>
              Đăng nhập Shopify hiện chưa khả dụng. Vui lòng thử lại sau.
            </div>
          )}

          <div className={styles.secureNote}>
            <span className={styles.lockIcon} aria-hidden="true">●</span>
            Đăng nhập bảo mật qua Shopify OAuth
          </div>
        </aside>
      </section>

      <section className={styles.features} aria-label="Key capabilities">
        <div className={styles.featuresIntro}>
          <p>Tại sao chọn AI-Buyense?</p>
          <h2>Tìm kiếm thông minh hơn.<br />Trải nghiệm liền mạch hơn.</h2>
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
        <span>© {new Date().getFullYear()} AI-Buyense</span>
        <span>Semantic commerce search for Shopify</span>
      </footer>
    </main>
  );
}
