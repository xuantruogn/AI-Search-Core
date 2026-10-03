# Hướng dẫn Shopify: kiểm thử chu kỳ thanh toán thực tế cho AI-Buyense

Cập nhật: 2026-10-02

## 1. Mục đích

Tài liệu này ghi lại cách Shopify hướng dẫn kiểm thử phần thanh toán ứng dụng bằng dữ liệu và chu kỳ do Shopify quản lý.

Mục tiêu của AI-Buyense từ giai đoạn này:

> Shopify tự tạo và quản lý trạng thái thanh toán. AI-Buyense chỉ quan sát, nhận thông báo, hỏi lại Shopify khi cần, cập nhật cơ sở dữ liệu nội bộ, tính quyền sử dụng và hiển thị kết quả cho người dùng.

Không sửa trực tiếp cơ sở dữ liệu để làm giả trạng thái Shopify.

Không sửa thời gian kết thúc chu kỳ trong cơ sở dữ liệu AI-Buyense để ép Shopify chuyển trạng thái.

Không dùng việc phát lại thông báo giả làm bằng chứng cho một chu kỳ Shopify thực sự.

## 2. Mô hình thanh toán mà AI-Buyense đang dùng

Mã hiện tại của AI-Buyense sử dụng cơ chế thanh toán thủ công của Shopify qua API quản trị GraphQL. Đây là cơ chế Shopify vẫn hỗ trợ cho các ứng dụng đã có tích hợp này, dù Shopify hiện khuyến nghị cơ chế quản lý gói thanh toán của Shopify cho ứng dụng công khai mới.

Nguồn Shopify:
- https://shopify.dev/docs/apps/launch/billing
- https://shopify.dev/docs/apps/launch/billing/manual-pricing
- https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing

AI-Buyense tạo gói định kỳ bằng `appSubscriptionCreate`. Shopify trả về đường dẫn xác nhận. Người bán chấp nhận hoặc từ chối trên giao diện của Shopify. Sau đó ứng dụng kiểm tra lại trạng thái từ Shopify.

## 3. Cửa hàng kiểm thử chính thức

Shopify cho phép kiểm thử luồng thanh toán trên cửa hàng phát triển. Với cửa hàng phát triển thuộc cùng tổ chức Đối tác với ứng dụng, người bán có thể chọn gói và kiểm tra toàn bộ luồng mà không phát sinh khoản thu thực tế.

Shopify cũng hỗ trợ giao dịch kiểm thử cho đối tượng `AppSubscription`. Trường `test` cho biết giao dịch đó có phải giao dịch kiểm thử hay không.

Nguồn:
- https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
- https://shopify.dev/docs/api/admin-graphql/latest/objects/AppSubscription
- https://shopify.dev/docs/api/admin-graphql/latest/enums/AppSubscriptionStatus

### Quy tắc của dự án

Môi trường kiểm thử thực tế phải dùng cửa hàng phát triển/kiểm thử của Shopify.

Mỗi lần kiểm thử phải ghi rõ:
- cửa hàng;
- mã gói;
- mã đăng ký Shopify;
- giá;
- loại chu kỳ;
- thời điểm bắt đầu;
- thời điểm kết thúc chu kỳ do Shopify trả về;
- trạng thái Shopify;
- thời điểm ứng dụng nhận thông báo;
- trạng thái cơ sở dữ liệu trước và sau;
- quyền sử dụng trước và sau;
- kết quả giao diện.

## 4. Các trạng thái Shopify mà mã hiện tại phải theo dõi

Đối tượng `AppSubscription` hiện có các trạng thái:

- `PENDING`: đã tạo đăng ký nhưng đang chờ người bán chấp nhận.
- `ACTIVE`: đăng ký đang hoạt động.
- `FROZEN`: đăng ký bị tạm giữ do vấn đề thanh toán; Shopify mô tả rằng đăng ký có thể hoạt động lại sau khi thanh toán được khôi phục.
- `CANCELLED`: đăng ký đã bị hủy; đây là trạng thái kết thúc.
- `DECLINED`: người bán từ chối đăng ký; đây là trạng thái kết thúc.
- `EXPIRED`: đăng ký không được chấp nhận trong thời hạn Shopify quy định; đây là trạng thái kết thúc.
- `ACCEPTED`: giá trị cũ đã bị đánh dấu không còn dùng.

Nguồn:
https://shopify.dev/docs/api/admin-graphql/latest/enums/AppSubscriptionStatus

## 5. Chu kỳ và thời điểm kết thúc

Shopify hỗ trợ chu kỳ định kỳ 30 ngày và hằng năm cho thanh toán theo thời gian.

Đối tượng `AppSubscription` có trường `currentPeriodEnd`, là thời điểm kết thúc chu kỳ hiện tại do Shopify quản lý.

Ứng dụng chỉ đọc giá trị này.

Ứng dụng không có quyền đặt lại `currentPeriodEnd` của Shopify để giả lập thời gian.

Nguồn:
- https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing/create-time-based-subscriptions
- https://shopify.dev/docs/api/admin-graphql/latest/objects/AppSubscription

## 6. Luồng kiểm thử chuẩn của Shopify

### Bước 1 — cài ứng dụng vào cửa hàng phát triển

Cài đúng phiên bản mã đang cần kiểm tra.

Kiểm tra ứng dụng khởi động bình thường.

### Bước 2 — bắt đầu chọn gói

Từ giao diện thanh toán của AI-Buyense, tạo gói.

Mã hiện tại gọi `appSubscriptionCreate`.

Shopify trả về đường dẫn xác nhận.

### Bước 3 — ghi trạng thái trước khi người bán chấp nhận

Ghi lại:
- mã đăng ký Shopify;
- trạng thái `PENDING`;
- gói;
- giá;
- tiền tệ;
- chu kỳ;
- thời điểm tạo;
- thời điểm kết thúc nếu Shopify đã trả về;
- trạng thái nội bộ của AI-Buyense;
- quyền sử dụng.

Kỳ vọng: chưa cấp quyền sử dụng gói trả phí chỉ vì đăng ký đã được tạo.

### Bước 4 — người bán chấp nhận trên Shopify

Đây là bước Shopify thực sự thay đổi trạng thái.

Sau khi chấp nhận, Shopify chuyển đăng ký sang `ACTIVE` nếu điều kiện của đăng ký cho phép hoạt động ngay.

AI-Buyense phải:
1. nhận thông báo thay đổi đăng ký nếu Shopify gửi;
2. xác thực thông báo;
3. hỏi lại Shopify bằng API quản trị;
4. xác nhận đúng mã đăng ký;
5. cập nhật cơ sở dữ liệu;
6. tính lại quyền sử dụng;
7. cập nhật trạng thái giao diện.

### Bước 5 — theo dõi sự kiện tự động

AI-Buyense đăng ký chủ đề `APP_SUBSCRIPTIONS_UPDATE`.

Trong mã hiện tại, đường dẫn nhận thông báo là:

`/webhooks/app/subscriptions_update`

Handler hiện tại:
- xác thực thông báo;
- lấy cửa hàng, mã đăng ký và trạng thái;
- chống xử lý trùng;
- phát hiện thông báo đến sai thứ tự;
- hỏi lại Shopify bằng API quản trị;
- dùng kết quả Shopify để hòa giải trạng thái;
- chạy hòa giải trạng thái thương mại sau khi xác nhận.

### Bước 6 — kiểm tra dữ liệu nội bộ

Sau khi Shopify thay đổi, kiểm tra:
- bản ghi đăng ký;
- mã đăng ký Shopify;
- gói;
- giá;
- tiền tệ;
- chu kỳ;
- thời gian bắt đầu/kết thúc;
- trạng thái thanh toán;
- trạng thái thanh toán chi tiết;
- trạng thái hủy;
- trạng thái quyền sử dụng;
- sự kiện thanh toán;
- trạng thái hòa giải.

### Bước 7 — kiểm tra quyền sử dụng

Không suy ra quyền chỉ từ việc nhận được thông báo.

Quyền sử dụng phải được tính từ trạng thái Shopify đã xác nhận và quy tắc nghiệp vụ của AI-Buyense.

Ví dụ hiện tại:
- `ACTIVE` → có thể có quyền BASIC/PRO/CUSTOM;
- `FROZEN` → trạng thái quyền sử dụng là `SUSPENDED`;
- `CANCELLED + NON_RENEWING + còn thời gian` → vẫn có quyền trong phần thời gian còn lại;
- hủy đã có hiệu lực → không còn quyền.

### Bước 8 — kiểm tra giao diện quản trị

Mở lại trang Gói và Thanh toán.

Xác nhận giao diện phản ánh đúng trạng thái Shopify mới nhất.

Không dùng việc giao diện hiển thị đúng làm bằng chứng duy nhất. Phải đối chiếu với Shopify và cơ sở dữ liệu.

## 7. Hủy đăng ký

Shopify cung cấp `appSubscriptionCancel`.

Shopify mô tả hai kiểu hành vi chính:
- tắt gia hạn tiếp theo nhưng cho phép đăng ký hiện tại chạy đến hết chu kỳ;
- hủy ngay theo hành vi thay thế được chọn, có thể kèm hoàn tiền theo tỷ lệ.

Nguồn:
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/appsubscriptioncancel
- https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing

Vì vậy không được coi mọi `CANCELLED` là mất quyền ngay lập tức. AI-Buyense phải kiểm tra thêm thời gian kết thúc chu kỳ và cách hủy thực tế.

## 8. Gỡ ứng dụng

Shopify ghi rõ khi người bán gỡ ứng dụng, đăng ký ứng dụng sẽ tự động bị hủy.

Nguồn:
https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing

AI-Buyense hiện có handler:
`/webhooks/app/uninstalled`

Handler:
- đánh dấu cửa hàng đã gỡ;
- xóa phiên đăng nhập;
- dọn trạng thái quyền thương mại;
- ghi sự kiện gỡ ứng dụng;
- không tự khởi tạo lại cửa hàng khi nhận thông báo gỡ.

## 9. Dùng thử

Shopify cho phép tạo đăng ký có số ngày dùng thử bằng `trialDays`.

Dùng thử làm lùi thời điểm bắt đầu tính phí; dùng thử không phải một trạng thái riêng của `AppSubscriptionStatus`.

Shopify cũng cung cấp `appSubscriptionTrialExtend` để kéo dài thời gian dùng thử.

Nguồn:
https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing/offer-free-trials

## 10. Thay đổi gói

Khi đổi gói, Shopify xử lý đăng ký mới theo hành vi thay thế được chọn.

Đặc biệt cần kiểm tra:
- nâng gói;
- hạ gói;
- 30 ngày → hằng năm;
- hằng năm → 30 ngày;
- áp dụng ngay;
- áp dụng vào chu kỳ tiếp theo;
- thời điểm hiệu lực;
- hoàn/khấu trừ theo quy tắc Shopify.

Nguồn:
https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing

## 11. Điều rất quan trọng về thời gian

Trong tài liệu Shopify đã kiểm tra cho dự án này, có mô tả rõ:
- chu kỳ 30 ngày;
- chu kỳ hằng năm;
- `currentPeriodEnd`;
- dùng thử;
- gia hạn dùng thử;
- hủy;
- thay thế đăng ký.

Nhưng chưa tìm thấy một API chính thức cho phép ứng dụng đặt một đăng ký 30 ngày thành “chỉ còn 5 phút” hoặc tự đặt `currentPeriodEnd` của Shopify.

Vì vậy:

**Không được sửa cơ sở dữ liệu AI-Buyense để giả thời gian Shopify.**

Nếu một trường hợp cần thời gian thực đi đến hạn chu kỳ mà Shopify không cung cấp cơ chế tăng tốc chính thức, trường hợp đó phải được đánh dấu là “chờ chu kỳ Shopify thực tế”, không được đổi thành bài kiểm thử giả.

## 12. Phân biệt hai loại thông báo dễ nhầm

AI-Buyense đang dùng thanh toán cho chính ứng dụng. Đối tượng cần kiểm tra là `AppSubscription`.

Không được nhầm với `SubscriptionContract`, là cơ chế để cửa hàng bán sản phẩm theo đăng ký cho khách hàng của cửa hàng.

Các thông báo `subscription_contracts/*` thuộc bài toán sản phẩm của cửa hàng, không phải vòng đời thanh toán ứng dụng AI-Buyense.

## 13. Nguồn Shopify chính thức đã dùng

- https://shopify.dev/docs/apps/launch/billing
- https://shopify.dev/docs/apps/launch/billing/manual-pricing
- https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing
- https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing/create-time-based-subscriptions
- https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing/offer-free-trials
- https://shopify.dev/docs/api/admin-graphql/latest/objects/AppSubscription
- https://shopify.dev/docs/api/admin-graphql/latest/enums/AppSubscriptionStatus
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/appsubscriptioncancel

## 14. Nguyên tắc kiểm thử của AI-Buyense

> Shopify tạo trạng thái → Shopify gửi tín hiệu → AI-Buyense xác thực → AI-Buyense hỏi lại Shopify → AI-Buyense ghi nhận → AI-Buyense tính quyền → người dùng nhìn thấy kết quả.

Đây là chuỗi bằng chứng cần dùng cho kiểm thử thực tế từ giai đoạn C trở đi.
