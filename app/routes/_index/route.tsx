import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>AI Search Bridge for Shopify</h1>
        <p className={styles.text}>
          Tìm kiếm sản phẩm theo ngữ nghĩa bằng AI, trong khi giao diện kết quả
          vẫn được render bằng chính theme Shopify của cửa hàng.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                autoComplete="url"
                placeholder="my-store.myshopify.com"
              />
              <span>Nhập domain *.myshopify.com của cửa hàng.</span>
            </label>
            <button className={styles.button} type="submit">
              Đăng nhập với Shopify
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <strong>Semantic AI Search.</strong> OpenAI tạo embedding cho truy
            vấn và Qdrant xếp hạng sản phẩm theo độ tương đồng ngữ nghĩa.
          </li>
          <li>
            <strong>Native Theme Rendering.</strong> App không tự dựng product
            card; Theme Renderer Bridge tái sử dụng Liquid/snippet của theme.
          </li>
          <li>
            <strong>Commercial-ready controls.</strong> Hỗ trợ Basic/Pro, quota,
            usage logs, background catalog sync và fallback an toàn về Shopify
            Search mặc định.
          </li>
        </ul>
      </div>
    </div>
  );
}
