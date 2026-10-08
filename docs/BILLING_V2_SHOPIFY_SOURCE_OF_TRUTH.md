# Billing V2 — Shopify Source of Truth & Verification Policy

## 1. Mục đích

Billing V2 phải xác minh trạng thái subscription từ Shopify. Ứng dụng không được tự suy đoán rằng merchant đã approve, đã thanh toán, đang ACTIVE, đã CANCELLED hoặc đã có entitlement chỉ dựa trên local state.

**Nguyên tắc bắt buộc:**

> Shopify Admin API là source of truth cho subscription state. App chỉ reconcile, persist và phản ánh trạng thái mà Shopify xác nhận.

## 2. Chuỗi chứng thực bắt buộc

Một trạng thái Billing chỉ được coi là VERIFIED khi có đủ bằng chứng theo chuỗi:

```text
Shopify
  ↓
Admin API xác nhận subscription GID + status + plan/price/interval/trial khi có
  ↓
Callback / Webhook
  ↓
App reconcile với Shopify Admin API
  ↓
BillingSubscription
  ↓
AiSearchShop current/pending pointer
  ↓
Entitlement / access
  ↓
UI
```

Callback hoặc webhook không tự thân là source of truth cuối cùng. Callback/webhook là trigger để app gọi Admin API và xác minh lại.

## 3. Các trạng thái không được suy đoán

| Shopify state | App phải làm |
|---|---|
| PENDING | Giữ pending; không cấp entitlement paid/active mới |
| ACTIVE | Chỉ sau khi Shopify xác nhận ACTIVE mới cập nhật current subscription và entitlement |
| FROZEN | Giữ FROZEN riêng; không biến thành CANCELLED bằng suy đoán |
| CANCELLED | Ghi nhận đúng subscription/GID và xử lý access theo effective cancellation |
| DECLINED | Không active; replacement bị decline không được thay thế current entitlement |
| EXPIRED | Không active; giữ lịch sử subscription |

Không được biến các trường hợp như subscription không tìm thấy, pending, hoặc DB có record thành một trạng thái khác nếu Shopify chưa xác nhận.

## 4. DB không phải source of truth

Các bảng local như BillingSubscription, BillingEvent và pointer AiSearchShop.currentSubscriptionGid là dữ liệu đồng bộ/audit của app.

App không được làm:

```text
DB có subscription
→ tự coi ACTIVE
→ cấp entitlement
```

Thay vào đó:

```text
Shopify xác nhận ACTIVE
→ reconcile
→ ghi DB
→ entitlement
```

Nếu pointer và snapshot local mâu thuẫn, app phải ưu tiên dữ liệu subscription được xác định từ Shopify/GID và thực hiện reconciliation; không chọn một subscription khác chỉ để làm state local đẹp.

## 5. Tiêu chí PASS của test

Không đánh VERIFIED chỉ vì:
- code đã compile/typecheck;
- callback chạy thành công;
- webhook nhận thành công;
- DB có record;
- UI hiển thị đúng.

Một test chỉ được PASS/VERIFIED khi chứng minh được chuỗi:
1. Shopify tạo/trả subscription.
2. Shopify xác nhận trạng thái cuối cùng bằng Admin API.
3. Callback/webhook được xử lý.
4. App reconcile đúng GID và status với Shopify.
5. DB phản ánh đúng subscription đã được Shopify xác nhận.
6. Entitlement/access phù hợp.
7. UI phản ánh đúng kết quả.

Nếu thiếu bằng chứng Shopify, trạng thái phải là CHƯA TEST hoặc INCONCLUSIVE, không được suy diễn thành PASS.

## 6. Ví dụ T001 — Basic Trial

Flow đã chứng thực:

```text
appSubscriptionCreate
→ Shopify PENDING
→ merchant APPROVE
→ Shopify ACTIVE
→ Admin API xác nhận đúng GID + BASIC + ACTIVE
→ callback/webhook
→ reconcile
→ BillingSubscription = ACTIVE
→ currentSubscriptionGid = Shopify GID
→ entitlement BASIC
→ UI BASIC
```

Đây là PASS vì trạng thái ACTIVE được Shopify xác nhận trước khi app cấp entitlement.

## 7. Quy tắc cho các test tiếp theo

Đối với mọi Txxx trong test matrix, evidence phải ưu tiên theo thứ tự:
1. Shopify Admin API
2. Shopify webhook/callback delivery
3. App reconciliation log
4. Billing DB
5. Entitlement
6. UI

Nếu các tầng sau đúng nhưng tầng 1 chưa được chứng minh, không được coi là Shopify-verified.

## 8. Charge / Payment / Refund

Không được tạo hoặc suy đoán BillingCharge chỉ để làm cho test PASS.

Nếu một test yêu cầu chứng minh payment/charge/refund lifecycle mà Shopify cung cấp dữ liệu tương ứng nhưng schema hiện tại không lưu được đầy đủ bằng chứng, test phải ghi nhận phần thiếu schema thay vì tự suy diễn trạng thái.

## 9. Audit rule

Mọi thay đổi Billing V2 phải trả lời được ba câu:
- Shopify đã xác nhận gì?
- App đã reconcile gì từ Shopify?
- DB/entitlement/UI có phản ánh đúng dữ liệu đã xác nhận đó không?

Đây là tiêu chí nền tảng để phân biệt IMPLEMENTED, TESTED và VERIFIED.