# Kế hoạch kiểm thử vòng đời thực tế Shopify — AI-Buyense

Cập nhật: 2026-10-02

## 1. Mục tiêu

Giai đoạn này không kiểm tra bằng cách sửa cơ sở dữ liệu.

Mục tiêu là quan sát một vòng đời thật:

**Shopify thay đổi → Shopify gửi thông báo → AI-Buyense nhận → AI-Buyense hỏi lại Shopify → cơ sở dữ liệu thay đổi → quyền sử dụng thay đổi → giao diện thay đổi.**

Một bài kiểm thử chỉ được coi là “thực tế” khi trạng thái nguồn được Shopify tạo ra, không phải do ta ghi đè vào cơ sở dữ liệu.

## 2. Trạng thái đã có bằng chứng từ kiểm thử trước

### T01–T12

Đây là các kiểm thử ứng dụng thực tế đã chạy trước phần mô phỏng, gồm:
- tạo/chuyển gói;
- nâng/hạ gói;
- 30 ngày/hằng năm;
- hủy gia hạn;
- dùng thử;
- trạng thái chờ;
- trường hợp mã đăng ký chưa xuất hiện ngay;
- trạng thái gói và hợp đồng dữ liệu của phía máy chủ.

### S01–S30

Đây là kiểm thử mô phỏng máy trạng thái, đã đạt 30/30.

Chúng chứng minh các nhánh xử lý nội bộ và trường hợp cạnh khó, nhưng **không thay thế bằng chứng Shopify thật**.

Từ đây trở đi, kiểm thử Shopify thật dùng kết quả S01–S30 để chọn những trường hợp cần quan sát ngoài thực tế.

## 3. Nguyên tắc không can thiệp

Trong tất cả bài kiểm thử C:

Không:
- sửa `currentPeriodEnd` trong cơ sở dữ liệu;
- sửa trạng thái đăng ký trong cơ sở dữ liệu;
- chèn giả sự kiện vào bảng sự kiện;
- phát lại thông báo giả rồi gọi đó là vòng đời thật;
- dùng dữ liệu mô phỏng để kết luận Shopify sẽ hành xử như vậy.

Được:
- tạo gói kiểm thử qua Shopify;
- chấp nhận/từ chối trên giao diện Shopify;
- hủy theo luồng ứng dụng;
- đổi gói theo luồng ứng dụng;
- dùng thử và gia hạn dùng thử theo khả năng Shopify;
- gỡ/cài lại ứng dụng;
- chờ Shopify tự chuyển trạng thái;
- đọc API quản trị của Shopify;
- đọc nhật ký của ứng dụng;
- đọc cơ sở dữ liệu AI-Buyense sau khi sự kiện xảy ra.

## 4. Cách ghi một bài kiểm thử

Mỗi bài phải có 7 mốc:

1. **TRƯỚC**: chụp trạng thái Shopify và AI-Buyense.
2. **HÀNH ĐỘNG**: chỉ thao tác được Shopify hỗ trợ.
3. **SHOPIFY**: ghi trạng thái Shopify sau hành động.
4. **THÔNG BÁO**: ghi thời điểm AI-Buyense nhận thông báo.
5. **XỬ LÝ**: ghi các bước hòa giải của AI-Buyense.
6. **SAU**: chụp cơ sở dữ liệu, quyền sử dụng và giao diện.
7. **ĐỐI CHIẾU**: Shopify ↔ ứng dụng ↔ cơ sở dữ liệu ↔ quyền ↔ giao diện.

## 5. Bộ C — kiểm thử Shopify thật

### C01 — tạo gói và trạng thái chờ

**Mục tiêu:** chứng minh trạng thái chờ thật từ Shopify.

Quy trình:
1. Dùng cửa hàng phát triển.
2. Mở AI-Buyense.
3. Chọn BASIC.
4. Ghi mã đăng ký Shopify.
5. Chưa chấp nhận ngay.
6. Kiểm tra Shopify: `PENDING`.
7. Kiểm tra AI-Buyense: chưa có quyền trả phí.

Kết quả cần có:
- mã đăng ký giống nhau;
- Shopify là nguồn xác nhận;
- cơ sở dữ liệu không tự cấp quyền;
- giao diện thể hiện đang chờ.

### C02 — chấp nhận và chuyển sang đang hoạt động

**Mục tiêu:** kiểm tra sự chuyển đổi thật `PENDING → ACTIVE`.

Quy trình:
1. Từ C01 mở đường dẫn xác nhận Shopify.
2. Chấp nhận.
3. Không sửa cơ sở dữ liệu.
4. Theo dõi nhật ký ứng dụng.
5. Theo dõi thông báo `APP_SUBSCRIPTIONS_UPDATE`.
6. Ứng dụng hỏi lại Shopify.
7. Kiểm tra cơ sở dữ liệu.
8. Kiểm tra quyền BASIC.
9. Mở lại trang thanh toán.

Kết quả cần có:
- Shopify xác nhận `ACTIVE`;
- mã đăng ký không đổi;
- giá/chu kỳ đúng;
- quyền BASIC được cấp;
- trang quản trị phản ánh đúng.

### C03 — dùng thử kết thúc thật

**Mục tiêu:** kiểm tra chuyển từ dùng thử sang trạng thái sau dùng thử mà không sửa thời gian trong DB.

Quy trình:
1. Tạo một đăng ký mới có dùng thử theo cấu hình Shopify.
2. Ghi `trialDays`, thời điểm bắt đầu và kết thúc.
3. Ghi nhật ký trước khi đến hạn.
4. Để Shopify tự xử lý đến thời điểm kết thúc.
5. Theo dõi thông báo và việc hỏi lại Shopify.
6. Đối chiếu trạng thái trước/sau.

Nếu thời gian dùng thử trong môi trường hiện tại quá dài và Shopify không có cơ chế tăng tốc chính thức cho `AppSubscription`, ghi C03 là “chờ thời gian thực”, không giả lập.

### C04 — gia hạn dùng thử

**Mục tiêu:** kiểm tra Shopify thay đổi thời gian dùng thử thật.

Quy trình:
1. Tạo đăng ký có dùng thử.
2. Ghi thời gian kết thúc.
3. Gọi luồng `appSubscriptionTrialExtend` nếu đây là chức năng mà mã sản phẩm cần kiểm tra.
4. Xác nhận Shopify trả về thời gian mới.
5. Kiểm tra ứng dụng đọc đúng giá trị mới.
6. Không sửa DB để bắt chước thời gian mới.

### C05 — hủy gia hạn nhưng vẫn còn quyền

**Mục tiêu:** kiểm tra trường hợp Shopify cho phép tiếp tục đến hết chu kỳ.

Quy trình:
1. Có một đăng ký BASIC đang `ACTIVE`.
2. Ghi `currentPeriodEnd`.
3. Bấm hủy gia hạn trong AI-Buyense.
4. Ghi phản hồi từ Shopify.
5. Theo dõi thông báo.
6. Kiểm tra AI-Buyense chuyển sang trạng thái không gia hạn.
7. Trước `currentPeriodEnd`, quyền vẫn còn.
8. Sau khi Shopify thực sự kết thúc, kiểm tra lại quyền.

Điểm quan trọng:
`CANCELLED` không được tự động đồng nghĩa với “mất quyền ngay”.

### C06 — thay đổi gói có hiệu lực theo chu kỳ

**Mục tiêu:** kiểm tra Shopify tự quyết định thời điểm áp dụng thay đổi gói.

Các nhánh cần chọn theo cấu hình hiện tại:
- BASIC → PRO;
- PRO → BASIC;
- 30 ngày → hằng năm;
- hằng năm → 30 ngày.

Mỗi lần:
1. Ghi gói hiện tại.
2. Tạo đăng ký mới.
3. Chấp nhận trên Shopify.
4. Ghi cả mã đăng ký cũ và mới.
5. Theo dõi thông báo.
6. Kiểm tra cơ sở dữ liệu.
7. Kiểm tra gói hiện tại và gói chờ.
8. Kiểm tra thời điểm có hiệu lực.
9. Kiểm tra quyền.

### C07 — gỡ ứng dụng và cài lại

**Mục tiêu:** kiểm tra vòng đời do Shopify tạo ra.

Quy trình:
1. Có đăng ký đang hoạt động.
2. Ghi trạng thái trước.
3. Gỡ AI-Buyense khỏi cửa hàng.
4. Theo dõi thông báo gỡ ứng dụng.
5. Kiểm tra Shopify đã hủy đăng ký.
6. Kiểm tra AI-Buyense đánh dấu cửa hàng đã gỡ.
7. Kiểm tra quyền bị thu hồi.
8. Cài lại.
9. Kiểm tra ứng dụng không tự hồi sinh đăng ký cũ nếu Shopify không còn đăng ký hoạt động.

## 6. Bộ kiểm thử bổ sung sau C01–C07

Sau khi C01–C07 hoàn thành, mới đi sâu vào:

### D01 — giá hoặc tiền tệ không đúng

Mục tiêu: xác nhận ứng dụng không cấp sai quyền khi dữ liệu giá/tiền tệ không đúng cấu hình.

### D02 — hoàn tiền một phần/toàn phần

Chỉ thực hiện nếu luồng thanh toán hiện tại của AI-Buyense thực sự có xử lý phần này.

### D03 — gói tùy chỉnh

Kiểm tra toàn bộ vòng đời gói tùy chỉnh.

### D04 — thông báo trùng và đến sai thứ tự

C01–C07 phải ưu tiên sự kiện thật. Nếu cần kiểm tra riêng khả năng chịu thông báo trùng/sai thứ tự thì dùng bài kiểm thử cấp xử lý sự kiện, không gọi đó là vòng đời Shopify thật.

### D05 — hằng năm → 30 ngày

Kiểm tra riêng vì Shopify có quy tắc trì hoãn trong một số trường hợp thay thế.

### D06 — kiểm tra khôi phục sau trạng thái bị tạm giữ

Chỉ kết luận “đã kiểm thử thực tế” khi có cách chính thức của Shopify tạo ra trạng thái bị tạm giữ trong môi trường kiểm thử. Nếu không có cơ chế chính thức để ép trạng thái này, giữ ở mức mô phỏng S17/S18 và ghi rõ chưa có bằng chứng Shopify thật.

## 7. Nhật ký bắt buộc

Mỗi bài C/D phải tạo một bản ghi:

```
[REAL-SHOPIFY-TEST] C02
[TRƯỚC]
Shopify status: PENDING
Shopify subscription GID: ...
Plan: BASIC
Price: ...
Currency: USD
Interval: EVERY_30_DAYS
Current period end: ...

App DB status: ...
App access: ...
App UI: ...

[HÀNH ĐỘNG]
Merchant approved subscription in Shopify

[SHOPIFY]
Status after action: ACTIVE

[THÔNG BÁO]
Topic: APP_SUBSCRIPTIONS_UPDATE
Received at: ...
Webhook id: ...

[XỬ LÝ]
Authenticated: PASS
Admin re-query: PASS
Confirmed GID: PASS
Reconciliation: PASS

[SAU]
DB status: ...
DB plan: ...
DB period end: ...
Access: ...
UI: ...

[ĐỐI CHIẾU]
Shopify = DB = Access = UI: PASS/FAIL
```

## 8. Tiêu chuẩn đạt

Một bài C chỉ đạt khi:

- trạng thái nguồn do Shopify tạo;
- mã đăng ký khớp;
- ứng dụng nhận đúng thông báo nếu Shopify gửi;
- ứng dụng hỏi lại Shopify;
- cơ sở dữ liệu phản ánh trạng thái đã xác nhận;
- quyền sử dụng đúng;
- giao diện đúng;
- không sửa dữ liệu Shopify hoặc giả thời gian;
- có nhật ký đủ để truy nguyên.

Nếu Shopify chưa cung cấp cách chính thức để tạo một trạng thái cụ thể trong môi trường kiểm thử, ghi:

**CHƯA CÓ CÁCH TẠO THỰC TẾ CHÍNH THỨC**

Không đổi thành PASS bằng mô phỏng.

## 9. Thứ tự thực hiện từ bây giờ

1. C01 — PENDING thật.
2. C02 — ACTIVE thật.
3. C05 — hủy gia hạn và còn quyền.
4. C06 — thay đổi gói.
5. C07 — gỡ/cài lại.
6. C04 — gia hạn dùng thử.
7. C03 — chờ dùng thử kết thúc thật.
8. D01–D06 theo các khoảng trống còn lại.

C03 được xếp sau các bài có thể tạo trạng thái ngay vì nó phụ thuộc thời gian Shopify thực tế.

## 10. Nguyên tắc kết luận

Không hỏi:

“Cơ sở dữ liệu của ta có chuyển trạng thái đúng không?”

Mà phải hỏi:

“Shopify đã chuyển trạng thái gì, Shopify đã gửi gì, AI-Buyense đã nghe được gì, AI-Buyense đã hỏi lại Shopify ra sao, cơ sở dữ liệu đã ghi gì, quyền đã thay đổi thế nào và người dùng nhìn thấy gì?”

Đó mới là kiểm thử vòng đời thanh toán thực tế.
