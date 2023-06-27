import { DOC_VERSIONS } from '../../versions.js';

const select = document.getElementById('plugin-versions-select');

DOC_VERSIONS.forEach((version) => {
	const option = document.createElement('option');
	option.value = version;
	option.innerHTML = version;
	select.appendChild(option);
});

const locationSplit = location.pathname.split('/');
const thisVersion = locationSplit.find((path) =>
	['stable', 'dev', ...DOC_VERSIONS].includes(path)
);
select.value = DOC_VERSIONS.includes(thisVersion)
	? thisVersion
	: DOC_VERSIONS[0];
select.onchange = () => {
	const newPaths = window.location.pathname.replace(
		`/${thisVersion}/`,
		`/${select.value}/`
	);
	const newUrl = new URL(newPaths, window.location.origin);
	window.location.assign(newUrl);
};

const header = document.querySelector('header.tsd-page-toolbar #tsd-search');
if (!!header && select.className.includes('title')) {
	header.prepend(select);
}
