# User Billing Status Dictionary

These are AI-Buyense business/user-facing statuses. They are NOT Shopify enum values.

| ID | User-facing status | Access |
|---|---|---|
| U01 | Chưa đăng ký gói | No |
| U02 | Đang chờ xác nhận thanh toán | No / pending |
| U03 | Đang dùng thử | Yes |
| U04 | Đang dùng thử - đã tắt gia hạn | Yes until trial end |
| U05 | Đang sử dụng - thanh toán/gia hạn tự động | Yes |
| U06 | Đang sử dụng - đã tắt gia hạn | Yes until current period end |
| U07 | Thanh toán thất bại - cần xử lý | Policy-dependent |
| U08 | Tạm dừng do vấn đề thanh toán | Usually restricted |
| U09 | Thanh toán đã khôi phục | Yes |
| U10 | Đã hủy gói | No |
| U11 | Gói đã hết hạn | No |
| U12 | Thanh toán/gói bị từ chối | No |
| U13 | Đang chuyển gói | Depends on replacement timing |
| U14 | Đã chuyển sang gói mới | Yes |
| U15 | Ứng dụng đã bị gỡ | No |

## Display principles

U05 and U06 must be visibly different.

U06 should communicate that the shop can continue using the service until the current period ends, but the subscription will not continue afterward.

U03 and U04 must also be visibly different.

Do not expose Shopify enum names directly to normal users unless there is a deliberate technical/admin view.
