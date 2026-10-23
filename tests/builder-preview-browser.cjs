const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('cancelled 3D preview is absent from the customer page and photo area remains available',()=>{
 const html=fs.readFileSync('builder.html','utf8');assert.doesNotMatch(html,/id="buildPreview"|id="buildCanvas"|src="[^\"]*builder-preview\.js/);assert.match(html,/id="realCasePreview"/);
});
