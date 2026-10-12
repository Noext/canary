interface DashboardUiAssets {
  assets: { body: string; path: string; type: string }[];
  html: string;
}
declare module "*?ui" {
  const ui: DashboardUiAssets;
  export default ui;
}
