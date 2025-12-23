export interface Env {
  XML_TEMPLATES: KVNamespace;

  DEFAULT_MARKET?: string;
  DEFAULT_LOCALE?: string;
  DEFAULT_RING?: string;
}

export interface ResolveAllRequest {
  productInput?: string;
  market?: string;
  locale?: string;
  ring?: string;
  includeAppx?: boolean;
  includeNonAppx?: boolean;
}

export interface AppInfo {
  Name: string;
  Publisher: string;
  Description: string;
  CategoryId: string;
  ProductId: string;
}

export interface DownloadItem {
  fileName: string;
  fileLink: string;
  fileSize: string;
  isSelected: boolean;
  isSelectMode: boolean;
}

export interface ResolveAllResponse {
  productId?: string;
  appInfo?: AppInfo;
  cookie?: string;
  fileListXml?: string;
  appxPackages?: DownloadItem[];
  nonAppxPackages?: DownloadItem[];
  errors?: string[];
}
