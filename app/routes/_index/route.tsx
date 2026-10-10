import type { LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { getPublicPricing } from "../../services/commerce/public-pricing.server";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  try { return { showForm: Boolean(login), plans: await getPublicPricing(), pricingUnavailable: false }; }
  catch { console.error("[Landing] PRICING_UNAVAILABLE"); return { showForm: Boolean(login), plans: [], pricingUnavailable: true }; }
};
export const headers = () => ({ "Cache-Control": "no-store" });

function SearchIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m21 21-4.35-4.35m2.35-5.15a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" /></svg>;
}

function ArrowIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 10h11m-4-4 4 4-4 4" /></svg>;
}

function CheckIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5 10 3 3 7-7" /></svg>;
}

const problems = [
  ["0", "Không tìm thấy kết quả", "Từ khóa khác tên sản phẩm có thể khiến Shopify Search bỏ sót hàng đang có."],
  ["?", "Sản phẩm chưa đúng ý", "Tìm kiếm theo từ khóa khó hiểu nhu cầu, ngữ cảnh và các ràng buộc mua hàng."],
  ["↗", "Khách khó khám phá sản phẩm", "Truy vấn tự nhiên, từ đồng nghĩa hoặc khác ngôn ngữ làm giảm khả năng khám phá."],
];

const capabilities = [
  ["⌕", "Tìm kiếm theo ngữ nghĩa", "Hiểu câu tự nhiên, từ đồng nghĩa, lỗi diễn đạt và ý định thay vì chỉ so khớp từ khóa."],
  ["▥", "Phân tích tìm kiếm", "Theo dõi lượt tìm, lượt nhấp, truy vấn bất thường và chất lượng kết quả từ dữ liệu thật."],
  ["✦", "Dữ liệu sản phẩm có cấu trúc", "Kết hợp thuộc tính sản phẩm, ngữ cảnh shop và vector để tạo ứng viên phù hợp hơn."],
  ["◇", "Tích hợp giao diện an toàn", "Theme Map V4 dùng thẻ sản phẩm của giao diện hiện tại và chuyển về Shopify Search khi không tương thích."],
];

export default function App() {
  const { showForm, plans, pricingUnavailable } = useLoaderData<typeof loader>();

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <a className={styles.brand} href="#dau-trang" aria-label="Trang chủ AI-Buyense"><span className={styles.brandMark}><SearchIcon /></span><span>AI-Buyense</span></a>
        <nav className={styles.navigation} aria-label="Điều hướng chính"><a href="#tinh-nang">Tính năng</a><a href="#cach-hoat-dong">Cách hoạt động</a><a href="#bang-gia">Bảng giá</a><a href="/demo">Bản mẫu</a></nav>
        <div className={styles.headerActions}><a className={styles.loginLink} href="#dang-nhap">Đăng nhập</a><a className={styles.headerCta} href="#dang-nhap">Kết nối cửa hàng</a></div>
      </header>

      <section className={styles.hero} id="dau-trang">
        <div className={styles.heroCopy}>
          <div className={styles.eyebrow}>✦ Tìm kiếm AI cho Shopify</div>
          <h1>Tìm kiếm hiểu ý định. <span>Trả đúng sản phẩm.</span></h1>
          <p className={styles.lead}>AI-Buyense hiểu ngôn ngữ tự nhiên, thuộc tính, ngữ cảnh và truy vấn đa ngôn ngữ; sau đó xếp hạng sản phẩm phù hợp và hiển thị bằng chính giao diện Shopify của bạn.</p>
          <div className={styles.heroActions}><a className={styles.primaryButton} href="#dang-nhap">Kết nối cửa hàng <ArrowIcon /></a><a className={styles.secondaryButton} href="/demo">Xem bản mẫu <span aria-hidden="true">▶</span></a></div>
          <div className={styles.heroFacts}><span><CheckIcon /> Dùng thử chỉ áp dụng cho Basic theo cấu hình gói</span><span><CheckIcon /> Thanh toán qua Shopify</span><span><CheckIcon /> Giữ nguyên giao diện theme</span></div>
        </div>

        <div className={styles.searchPreview} aria-label="Minh họa kết quả tìm kiếm AI-Buyense">
          <div className={styles.previewSearch}><span>áo khoác chống nước đi tuyết</span><i><SearchIcon /></i></div>
          <div className={styles.previewCaption}>✦ Kết quả phù hợp nhất</div>
          <div className={styles.previewProducts}>
            {[["#e2a51d", "Áo khoác leo núi", "Chống nước · giữ ấm"], ["#19758c", "Áo khoác đi tuyết", "Chống gió · chống nước"], ["#252a34", "Áo khoác mùa đông", "Giữ nhiệt · đi ngoài trời"], ["#e8e9ed", "Áo khoác nhẹ", "Chống mưa · màu sáng"]].map(([color, title, detail]) => (
              <article className={styles.previewProduct} key={title}><div className={styles.productArt} style={{ "--coat-color": color } as React.CSSProperties}><span /><i /><b /></div><strong>{title}</strong><small>{detail}</small></article>
            ))}
          </div>
          <div className={styles.previewFlow}><span><b>⌕</b> Hiểu truy vấn<small>Ngôn ngữ tự nhiên</small></span><span><b>◎</b> Tìm ứng viên<small>So khớp ngữ nghĩa</small></span><span><b>⇅</b> Xếp hạng<small>Ràng buộc mua hàng</small></span></div>
        </div>
      </section>

      <section className={styles.stackBar} aria-label="Nền tảng và công nghệ"><p>NỀN TẢNG ĐƯỢC AI-BUYENSE TÍCH HỢP</p><div><strong>Shopify</strong><strong>Embedding OpenAI</strong><strong>Phân tích truy vấn Gemini</strong><strong>Qdrant</strong><strong>Theme Map V4</strong></div></section>

      <section className={styles.problemSection}>
        <div className={styles.sectionHeading}><span>VẤN ĐỀ CỦA TÌM KIẾM TỪ KHÓA</span><h2>Sản phẩm đúng có thể tồn tại nhưng khách vẫn không tìm thấy</h2><p>AI-Buyense bổ sung khả năng hiểu ý nghĩa mà không thay thế giao diện quen thuộc của cửa hàng.</p></div>
        <div className={styles.problemGrid}>{problems.map(([icon, title, description]) => <article key={title}><i>{icon}</i><div><h3>{title}</h3><p>{description}</p></div></article>)}</div>
      </section>

      <section className={styles.processSection} id="cach-hoat-dong">
        <div className={styles.sectionHeading}><span>HIỂU Ý ĐỊNH, GIỮ ĐÚNG TRẢI NGHIỆM</span><h2>Một luồng tìm kiếm rõ ràng từ truy vấn đến cửa hàng</h2></div>
        <div className={styles.processFlow}>{[["01", "Hiểu truy vấn", "Nhận diện ý định, thuộc tính, ngôn ngữ và ràng buộc."], ["02", "Tìm kiếm ngữ nghĩa", "Kết hợp dữ liệu có cấu trúc với độ tương đồng vector."], ["03", "Lọc và xếp hạng", "Áp dụng giới tính, giá, loại sản phẩm và điều kiện mua hàng."], ["04", "Hiển thị theo giao diện", "Giữ thứ tự AI nhưng sử dụng thẻ sản phẩm gốc của cửa hàng."]].map(([number, title, description], index) => <article className={styles.processStep} key={number}><div>{number}</div><h3>{title}</h3><p>{description}</p>{index < 3 ? <span aria-hidden="true">→</span> : null}</article>)}</div>
      </section>

      <section className={styles.capabilitySection} id="tinh-nang"><div className={styles.capabilityGrid}>{capabilities.map(([icon, title, description]) => <article key={title}><i>{icon}</i><h3>{title}</h3><p>{description}</p></article>)}</div></section>

      <section className={styles.dashboardSection}>
        <div className={styles.dashboardCopy}><span>TRUNG TÂM QUẢN TRỊ TÌM KIẾM</span><h2>Theo dõi những gì khách tìm và chất lượng kết quả</h2><ul><li><CheckIcon /> Theo dõi nhật ký tìm kiếm và lượt nhấp sản phẩm</li><li><CheckIcon /> Phát hiện truy vấn bất thường và không có kết quả</li><li><CheckIcon /> Quản lý danh mục, hạn mức, thanh toán và Theme Map</li></ul><a href="#dang-nhap">Mở trang quản trị <ArrowIcon /></a></div>
        <div className={styles.dashboardMock} aria-label="Mô phỏng giao diện phân tích"><div className={styles.mockTop}><b>Tổng quan tìm kiếm</b><span>Dữ liệu thực của cửa hàng</span></div><div className={styles.mockMetrics}><div><small>Lượt tìm kiếm</small><strong>Nhật ký</strong></div><div><small>Lượt nhấp</small><strong>Sản phẩm</strong></div><div><small>Chất lượng</small><strong>Cảnh báo</strong></div></div><div className={styles.mockBody}><div className={styles.mockChart}><span /><span /><span /><span /><span /><i /></div><div className={styles.mockQueries}><b>Truy vấn cần chú ý</b><span>Không có kết quả <i /></span><span>Độ tương đồng thấp <i /></span><span>Có kết quả, không nhấp <i /></span></div></div><small className={styles.mockNote}>Minh họa giao diện — không phải số liệu hiệu suất giả định.</small></div>
      </section>

      <section className={styles.setupSection}><div className={styles.sectionHeading}><span>THIẾT LẬP ĐƠN GIẢN</span><h2>Sẵn sàng tìm kiếm AI trong 3 bước</h2></div><div className={styles.setupSteps}><article><i>1</i><h3>Kết nối ứng dụng</h3><p>Đăng nhập an toàn bằng Shopify OAuth và chọn gói phù hợp.</p></article><article><i>2</i><h3>Đồng bộ danh mục</h3><p>AI-Buyense xử lý dữ liệu sản phẩm và tạo chỉ mục vector.</p></article><article><i>3</i><h3>Kích hoạt cửa hàng</h3><p>Bật App Embed, đồng bộ Theme Map và kiểm tra kết quả.</p></article></div></section>

      <section className={styles.pricingSection} id="bang-gia"><div className={styles.sectionHeading}><span>THANH TOÁN QUA SHOPIFY</span><h2>Gói dịch vụ rõ ràng theo quy mô cửa hàng</h2><p>Giá và hạn mức từ cấu hình gói hiện tại. Custom được báo giá riêng.</p></div>{pricingUnavailable ? <p role="alert">Chưa tải được bảng giá. Vui lòng thử lại sau.</p> : null}<div className={styles.pricingGrid}>{plans.map((plan) => <article className={plan.featured ? styles.pricingFeatured : undefined} key={plan.handle}>{plan.featured ? <em>Phổ biến</em> : null}<h3>{plan.name}</h3><p>{plan.description}</p><div className={styles.price}><strong>{plan.price}</strong><span>{plan.suffix}</span></div>{plan.trialDays > 0 ? <p>{plan.trialDays}-day free trial · new eligible stores only</p> : null}<ul>{plan.features.map((feature) => <li key={feature}><CheckIcon /> {feature}</li>)}</ul>{plan.billingPolicy.moneyBackGuaranteeDays > 0 ? <details><summary>{plan.billingPolicy.moneyBackGuaranteeDays}-day money-back guarantee</summary><p>{plan.billingPolicy.refundTerms}</p></details> : null}<a href="#dang-nhap">Bắt đầu với {plan.name}</a></article>)}</div></section>

      <section className={styles.loginSection} id="dang-nhap">
        <div><span>KẾT NỐI CỬA HÀNG</span><h2>Bắt đầu cải thiện khả năng khám phá sản phẩm</h2><p>Nhập tên miền <strong>*.myshopify.com</strong>. Shopify sẽ xử lý xác thực và quyền truy cập của ứng dụng.</p></div>
        <aside className={styles.loginCard} aria-labelledby="login-title"><p className={styles.cardEyebrow}>Đăng nhập bảo mật</p><h2 id="login-title">Kết nối với Shopify</h2>{showForm ? <Form className={styles.form} method="post" action="/auth/login"><label className={styles.label} htmlFor="shop-domain">Tên miền cửa hàng</label><div className={styles.inputWrap}><span className={styles.inputPrefix}>S</span><input id="shop-domain" className={styles.input} type="text" name="shop" inputMode="url" autoComplete="url" autoCapitalize="none" spellCheck={false} placeholder="ten-cua-hang.myshopify.com" required /></div><button className={styles.button} type="submit">Đăng nhập với Shopify <ArrowIcon /></button></Form> : <div className={styles.unavailable}>Đăng nhập Shopify hiện chưa khả dụng. Vui lòng thử lại sau.</div>}<div className={styles.secureNote}><span>●</span> Xác thực bằng Shopify OAuth</div></aside>
      </section>

      <section className={styles.finalCta}><div><span>✦</span><div><strong>Sẵn sàng nâng cấp trải nghiệm tìm kiếm?</strong><p>Kết nối danh mục và để khách tìm sản phẩm theo cách họ thực sự suy nghĩ.</p></div></div><a href="#dang-nhap">Kết nối cửa hàng</a></section>

      <footer className={styles.footer}><div><span className={styles.brandMark}><SearchIcon /></span><div><strong>AI-Buyense</strong><p>Tìm kiếm AI theo ngữ nghĩa dành cho Shopify.</p></div></div><nav><a href="#tinh-nang">Tính năng</a><a href="#cach-hoat-dong">Cách hoạt động</a><a href="#bang-gia">Bảng giá</a><a href="/demo">Bản mẫu</a></nav><span>© {new Date().getFullYear()} AI-Buyense</span></footer>
    </main>
  );
}
