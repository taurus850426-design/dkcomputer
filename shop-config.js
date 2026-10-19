/* Public feature switch. Backend independently controls ordering and payment. */
window.DKShopConfig = Object.freeze({ enabled: false, preview: new URLSearchParams(location.search).get('shop-preview') === '1' });
