import { withDistributedLease } from "../commerce/lease-lock.server";

type ProductSyncTask<T> = () => Promise<T>;

type ProductSyncLockInput<T> = {
  shop: string;
  productId: string;
  task: ProductSyncTask<T>;
};

// =====================================================
// IN-PROCESS PRODUCT LOCK
//
// Key:
//
// shop + productId
//
// Ví dụ:
//
// shop-a::gid://shopify/Product/123
//
// Nếu CREATE và UPDATE cùng đến một lúc:
//
// CREATE
//    ↓
// lock product
//    ↓
// embedding
//    ↓
// Qdrant
//    ↓
// unlock
//
// UPDATE
//    ↓
// đợi CREATE xong
//    ↓
// đọc hash mới
//    ↓
// skip embedding
// =====================================================

const productLocks = new Map<string, Promise<void>>();

function buildProductLockKey(shop: string, productId: string) {
  return `${shop}::${productId}`;
}

export async function withProductSyncLock<T>({
  shop,
  productId,
  task,
}: ProductSyncLockInput<T>): Promise<T> {
  const key = buildProductLockKey(shop, productId);

  // Lock hiện tại của product.
  // Nếu chưa có thì coi như đã resolve.
  const previous = productLocks.get(key) ?? Promise.resolve();

  // Gate mới.
  let release: (() => void) | undefined;

  const currentGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  // Tail đại diện cho toàn bộ hàng đợi
  // tới task hiện tại.
  const tail = previous
    .catch(() => {
      // Task trước fail cũng không được
      // làm hỏng hàng đợi.
    })
    .then(() => currentGate);

  productLocks.set(key, tail);

  // ===================================================
  // ĐỢI TASK TRƯỚC CÙNG PRODUCT
  // ===================================================

  await previous.catch(() => {
    // Task trước fail:
    // task sau vẫn được phép chạy.
  });

  console.log("[AI Search] Product sync lock acquired:", {
    shop,
    productId,
  });

  try {
    return await withDistributedLease({
      shop,
      resource: `product:${productId}`,
      task,
    });
  } finally {
    // =================================================
    // NHẢ LOCK
    // =================================================

    release?.();

    // Chỉ xóa Map nếu không có task mới
    // nối đuôi sau task hiện tại.
    if (productLocks.get(key) === tail) {
      productLocks.delete(key);
    }

    console.log("[AI Search] Product sync lock released:", {
      shop,
      productId,
    });
  }
}
