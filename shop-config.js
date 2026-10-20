/* Public feature switch. Backend independently controls ordering and payment. */
window.DKShopConfig = Object.freeze({ enabled: true, preview: new URLSearchParams(location.search).get('shop-preview') === '1' });
