export const THEME_MAP_V4_VERSION = 4 as const;

export const THEME_MAP_V4_DEFAULT_PAGE_SIZE = 20 as const;

export type RendererRuntimeMode =
  | "STATIC"
  | "CUSTOM_ELEMENT"
  | "STANDARD_EVENT"
  | "REQUIRES_REINIT"
  | "UNSUPPORTED";

export type RendererContextClass =
  | "PORTABLE"
  | "RESOLVABLE"
  | "CONTEXTUAL";

export type RendererCandidateStatus =
  | "ELIGIBLE"
  | "REJECTED";

/**
 * Chiến lược render thực tế của candidate.
 *
 * APP_PROXY_LIQUID:
 * - renderer có thể replay bằng Liquid do App Proxy trả về.
 * - runtime analyzer áp dụng trực tiếp.
 *
 * THEME_CONTEXT_REQUIRED:
 * - renderer cần section/block context thật của theme.
 * - ví dụ Shopify Theme Blocks dùng:
 *
 *   {% content_for 'block' %}
 *   {% content_for 'blocks' %}
 *
 * - không được replay trực tiếp bằng App Proxy Liquid.
 */
export type ThemeRendererStrategy =
  | "APP_PROXY_LIQUID"
  | "THEME_CONTEXT_REQUIRED";

export type ThemeArgumentValue =
  | string
  | number
  | boolean
  | null;

export interface ThemeDependency {
  filename: string;
  checksum: string;
}

export interface ProductBinding {
  sourceVariable: string;
  argument?: string;
}

export interface ThemeMountRecipe {
  sectionKey?: string;
  sectionType?: string;

  strategy:
    | "ELEMENT_ID"
    | "DATA_ATTRIBUTE"
    | "SOURCE_PROVEN_SELECTOR";

  selector: string;

  /**
   * File theme thật đã chứng minh selector này tồn tại.
   * Không cho phép selector đoán.
   */
  sourceFile: string;

  verification: {
    expectedTag?: string;

    /**
     * Mount point phải duy nhất.
     * Nếu runtime tìm thấy 0 hoặc > 1 element thì không takeover.
     */
    expectedMatchCount: 1;
  };
}

export interface ThemeRendererCandidate {
  id: string;

  type:
    | "SNIPPET"
    | "INLINE";

  /**
   * Chiến lược render của candidate.
   *
   * Classic snippet / inline Liquid:
   * APP_PROXY_LIQUID
   *
   * Shopify Theme Block cần section/block context:
   * THEME_CONTEXT_REQUIRED
   */
  renderStrategy: ThemeRendererStrategy;

  /**
   * File theme nơi renderer được phát hiện.
   */
  sourceFile: string;

  /**
   * Chỉ tồn tại khi type = SNIPPET.
   */
  snippet?: string;

  /**
   * Luồng product object đã được compiler chứng minh.
   */
  productBinding: ProductBinding;

  /**
   * Markup của một product item sau khi compile.
   * Bao gồm wrapper cần thiết của theme.
   */
  itemTemplate: string;

  /**
   * Chỉ chứa giá trị serialize-safe.
   * Không lưu arbitrary runtime object.
   */
  arguments: Record<
    string,
    ThemeArgumentValue
  >;

  contextClass:
    RendererContextClass;

  /**
   * Các file renderer thực sự phụ thuộc.
   */
  dependencies: string[];

  runtime: {
    mode: RendererRuntimeMode;

    /**
     * Ví dụ:
     * product-card
     * quick-add
     *
     * Chỉ dùng khi compiler chứng minh đây là custom element.
     *
     * Với THEME_CONTEXT_REQUIRED, runtime này chủ yếu là
     * diagnostic metadata chứ không quyết định khả năng
     * App Proxy render candidate.
     */
    customElement?: string;
  };

  /**
   * Renderer hoặc dependency có tự gọi all_products hay không.
   * Quan trọng vì Shopify giới hạn số unique handles.
   */
  usesAllProducts: boolean;

  /**
   * Điểm ưu tiên candidate.
   * Không được tính dựa vào filename kiểu card-product/product-card.
   */
  score: number;

  status:
    RendererCandidateStatus;

  /**
   * Dùng để debug theme không tương thích.
   */
  rejectionReasons: string[];

  /**
   * Mount thuộc chính candidate này.
   *
   * Candidate A và candidate B có thể render ở những vị trí khác nhau,
   * vì vậy không dùng một global mount chung cho mọi candidate.
   */
  mount?: ThemeMountRecipe;
}

export interface ThemeMapV4ThemeIdentity {
  id: string;
  name: string;
}

export interface ThemeMapV4SearchIdentity {
  templateFile: string;

  templateType:
    | "JSON"
    | "LIQUID";

  sectionKey?: string;
  sectionType?: string;
  sectionFile?: string;
}

interface ThemeMapV4Base {
  version:
    typeof THEME_MAP_V4_VERSION;

  theme:
    ThemeMapV4ThemeIdentity;

  search:
    ThemeMapV4SearchIdentity;

  rendererCandidates:
    ThemeRendererCandidate[];

  dependencies:
    ThemeDependency[];

  /**
   * Hash từ chính các dependency thực sự của renderer.
   */
  fingerprint: string;

  pageSize: number;
}

/**
 * VERIFIED nghĩa là có ít nhất một renderer candidate
 * ELIGIBLE + có source-proven mount.
 *
 * Hiện tại ELIGIBLE chỉ nên áp dụng cho strategy
 * mà runtime backend thực sự hỗ trợ.
 */
export interface VerifiedThemeMapV4
  extends ThemeMapV4Base {
  status: "VERIFIED";

  unsupportedReason?: never;
}

/**
 * Không tìm được renderer/mount an toàn.
 * Storefront phải fallback native Shopify Search.
 *
 * Theme Map vẫn có thể giữ candidate
 * THEME_CONTEXT_REQUIRED để phục vụ diagnostics
 * và renderer strategy tương lai.
 */
export interface UnsupportedThemeMapV4
  extends ThemeMapV4Base {
  status: "UNSUPPORTED";

  unsupportedReason: string;
}

export type ThemeMapV4 =
  | VerifiedThemeMapV4
  | UnsupportedThemeMapV4;