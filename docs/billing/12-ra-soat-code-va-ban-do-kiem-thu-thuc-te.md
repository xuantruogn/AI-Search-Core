# Rà soát mã nguồn Billing và bản đồ kiểm thử thực tế

Cập nhật: 2026-10-02

## 1. Phạm vi rà soát

Rà soát các phần đang trực tiếp quyết định vòng đời thanh toán:

- `app/services/billing/shopify-app-pricing.server.ts`
- `app/services/commerce/billing-state.server.ts`
- `app/services/commerce/reconciliation.server.ts`
- `app/services/commerce/shop-registry.server.ts`
- `app/routes/webhooks.app.subscriptions_update.tsx`
- `app/routes/webhooks.app.uninstalled.tsx`
- `app/routes/app.billing.tsx`
- `app/routes/app.tsx`
- `app/shopify.server.ts`
- `shopify.app.toml`

## 2. Kết quả rà soát

### 2.1 Shopify là nguồn trạng thái chính

Trong `shopify-app-pricing.server.ts`, ứng dụng đọc:
- mã đăng ký;
- trạng thái;
- thời gian tạo;
- thời gian cập nhật;
- thời điểm kết thúc chu kỳ;
- ngày dùng thử;
- cờ giao dịch kiểm thử;
- dòng giá;
- chu kỳ;
- giá;
- tiền tệ.

Ứng dụng không tự đặt trạng thái Shopify.

### 2.2 Khi nhận thông báo thay đổi đăng ký

`webhooks.app.subscriptions_update.tsx`:

1. xác thực thông báo;
2. kiểm tra mã đăng ký và trạng thái;
3. chống xử lý trùng bằng mã định danh xử lý;
4. kiểm tra thông báo đến sai thứ tự;
5. tạo kết nối quản trị Shopify;
6. gọi `reconcileShopifySubscriptionFromAdmin`;
7. chỉ sau khi xác nhận mới chạy hòa giải trạng thái thương mại.

Đây là đúng mô hình cần kiểm thử thực tế:

**Shopify → thông báo → hỏi lại Shopify → hòa giải → quyền.**

### 2.3 Hòa giải trạng thái

`shopify-app-pricing.server.ts` có logic dùng mã đăng ký cụ thể làm điểm neo.

Điểm quan trọng:
- mã đăng ký là định danh không đổi;
- gói có thể cần lấy từ dòng giá hoặc dữ liệu đã lưu theo đúng mã đăng ký;
- trạng thái Shopify được xác nhận lại qua API quản trị;
- trường hợp đăng ký đang chờ nhưng chưa xuất hiện ngay trong dữ liệu quản trị được xử lý riêng;
- đăng ký cũ không được tự nhiên ghi đè đăng ký mới.

### 2.4 Tính trạng thái thương mại và quyền

`billing-state.server.ts` tách:
- trạng thái đăng ký Shopify;
- trạng thái thương mại;
- trạng thái dùng thử;
- trạng thái hủy;
- trạng thái thay đổi gói;
- trạng thái thanh toán;
- trạng thái hoàn tiền;
- trạng thái quyền sử dụng;
- trạng thái hòa giải.

Đặc biệt:
- `FROZEN` → quyền `SUSPENDED`;
- `ACTIVE` → `TRIAL` hoặc `PAID`;
- `CANCELLED + NON_RENEWING + currentPeriodEnd còn trong tương lai` → vẫn có quyền;
- khi cửa sổ quyền không còn hiệu lực → `NONE`.

Đây là phần cần đặc biệt quan sát trong C03/C05.

### 2.5 Hòa giải trạng thái thương mại

`reconciliation.server.ts` lấy quyền hiện tại rồi chạy phục hồi dữ liệu sản phẩm và cân nhắc việc làm mới danh mục.

Khi trạng thái hoạt động được xác nhận, handler thông báo thay đổi đăng ký gọi hòa giải thương mại ở nền.

Vì vậy C02 và C06 không chỉ kiểm tra bảng thanh toán; phải kiểm tra cả quyền sử dụng và tác động đến dữ liệu thương mại.

### 2.6 Gỡ ứng dụng

`webhooks.app.uninstalled.tsx` gọi `markShopUninstalled`.

Hàm này:
- đánh dấu cửa hàng đã gỡ;
- xóa mã đăng ký hiện tại và mã đang chờ ở cửa hàng;
- đặt trạng thái đăng ký nội bộ thành hủy;
- tắt quyền;
- hủy các công việc đồng bộ còn đang chạy;
- ghi sự kiện gỡ ứng dụng.

Đây là phần chính của C07.

### 2.7 Tải trang ứng dụng

`app.tsx` hiện không chạy hòa giải thanh toán trên mọi lần tải trang.

Điều này quan trọng: vòng đời thanh toán được kích hoạt bởi đường về sau khi chọn gói, thông báo Shopify hoặc các đường xử lý chuyên biệt, thay vì biến mỗi lần mở trang thành một lần hòa giải.

Do đó trong C02/C05/C06, cần quan sát sự kiện trước khi mở lại trang. Mở trang chỉ là bước xác nhận giao diện cuối.

### 2.8 Cấu hình thông báo

`shopify.app.toml` hiện đăng ký:

`app_subscriptions/update`

với đường dẫn:

`/webhooks/app/subscriptions_update`

Ứng dụng cũng có đường dẫn nhận thông báo gỡ ứng dụng.

### 2.9 Phiên bản API

`app/shopify.server.ts` đang dùng phiên bản API được đặt qua `ApiVersion.July26`.

`shopify.app.toml` cấu hình phiên bản thông báo là `2026-10`.

Trong giai đoạn kiểm thử thực tế, cần ghi nhận cả hai cấu hình này khi lập biên bản để tránh nhầm phiên bản API dùng cho từng phần.

## 3. Những gì bộ mô phỏng đã chứng minh

S01–S30 đã kiểm tra:
- hủy không gia hạn;
- hủy có hiệu lực;
- chờ và từ chối;
- hết hạn;
- đóng băng và khôi phục;
- dùng thử;
- thay đổi gói;
- thông báo trễ/trùng/sai thứ tự;
- mã đăng ký cũ;
- mã đăng ký mới;
- thanh toán;
- gỡ/cài lại;
- các trường hợp đặc biệt về hủy.

Các bài này là bằng chứng cho logic nội bộ.

Chúng không chứng minh Shopify sẽ tự phát sinh đúng trạng thái trong thời gian thực.

## 4. Bản đồ từ trạng thái Shopify đến kiểm thử thực tế

| Trạng thái / sự kiện | Bằng chứng mô phỏng | Kiểm thử thực tế |
|---|---|---|
| PENDING | S02/S03/S19-S21 | C01 |
| ACTIVE | S05/S16 | C02 |
| Trial | S06-S08 | C03/C04 |
| CANCELLED còn thời gian | S28 | C05 |
| CANCELLED hết thời gian | S29/S30 | C05 + chờ Shopify |
| Thay đổi gói | S19-S21 | C06 |
| Gỡ ứng dụng | S24/S25 | C07 |
| FROZEN | S17/S18 | D06 nếu Shopify có cơ chế tạo chính thức |
| Thông báo trùng | S10 | D04 ở cấp xử lý thông báo |
| Thông báo sai thứ tự | S09/S11/S14 | D04 ở cấp xử lý thông báo |
| Giá/tiền tệ sai | S22/S23 liên quan dữ liệu gói | D01 |

## 5. Tiêu chí không sửa mã trong lúc kiểm thử

Nếu C01–C07 thất bại, trước tiên phân loại:

### Loại A — Shopify không tạo trạng thái như giả định
Không sửa mã ngay. Ghi lại bằng chứng Shopify.

### Loại B — Shopify tạo đúng, thông báo đến đúng, nhưng ứng dụng xử lý sai
Đây là lỗi mã thật. Tạo lỗi sửa mã.

### Loại C — Shopify tạo đúng, ứng dụng xử lý đúng, nhưng giao diện hiển thị cũ
Kiểm tra lại tải lại dữ liệu và cơ chế cập nhật giao diện.

### Loại D — mã đúng nhưng môi trường kiểm thử không nhận được thông báo
Kiểm tra đăng ký thông báo, địa chỉ nhận, xác thực và nhật ký trước khi sửa logic nghiệp vụ.

### Loại E — trường hợp Shopify không cung cấp cơ chế tạo chính thức
Không coi là lỗi mã. Ghi “chưa có cách tạo thực tế chính thức” và giữ bằng chứng mô phỏng S01–S30.

## 6. Kết luận rà soát

Mã hiện tại đã có cấu trúc phù hợp với mô hình:

**Shopify là nguồn sự thật → ứng dụng nghe thông báo → ứng dụng hỏi lại Shopify → ghi trạng thái nội bộ → tính quyền → hòa giải dữ liệu thương mại → giao diện đọc trạng thái.**

Giai đoạn tiếp theo vì vậy nên ưu tiên kiểm chứng chuỗi này bằng Shopify thật, không tiếp tục sửa cơ sở dữ liệu để mô phỏng thời gian.
