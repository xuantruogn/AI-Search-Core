# Billing State Mapping

## Purpose

Map Shopify technical state and billing facts to AI-Buyense user-facing status.

| User ID | Typical Shopify state/facts | User status |
|---|---|---|
| U01 | No active subscription | Chưa đăng ký gói |
| U02 | PENDING | Đang chờ xác nhận thanh toán |
| U03 | ACTIVE + trial in progress | Đang dùng thử |
| U04 | ACTIVE + trial + cancellation scheduled | Đang dùng thử - đã tắt gia hạn |
| U05 | ACTIVE + paid/active renewal lifecycle | Đang sử dụng - tự động gia hạn |
| U06 | ACTIVE + cancellation scheduled/end-of-period | Đang sử dụng - đã tắt gia hạn |
| U07 | Billing attempt failed / payment problem | Thanh toán thất bại - cần xử lý |
| U08 | FROZEN | Tạm dừng do vấn đề thanh toán |
| U09 | ACTIVE after recovery | Thanh toán đã khôi phục |
| U10 | CANCELLED | Đã hủy gói |
| U11 | EXPIRED or access period ended | Gói đã hết hạn |
| U12 | DECLINED | Gói/thanh toán bị từ chối |
| U13 | Replacement operation in progress | Đang chuyển gói |
| U14 | New subscription ACTIVE after replacement | Đã chuyển sang gói mới |
| U15 | App uninstalled / subscription cancelled as applicable | Ứng dụng đã bị gỡ |

## Warning

This is a business mapping, not a claim that every row maps to exactly one Shopify field.

Some statuses require multiple facts and/or event history.

For every implementation, record the exact API fields, events and timestamps used to derive the status.
