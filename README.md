# NSpy (Naver Spy - 네이버 스파이)

NSpy allows you to access posts on Naver Cafe that are searchable but restricted based on user grade. These posts can be accessed via search links but are blocked within the cafe due to grade verification. This Chrome extension lets you view these posts directly within the cafe without the need to search for them. Note that it only works for posts that are allowed to be indexed by Naver search.

네이버 카페에는 회원 등급과 관계없이 검색을 통해 볼 수 있는 글이 존재합니다. 이런 글들은 검색을 통한 링크를 이용하면 접근이 가능하지만 실제 카페에서 접근하면 등급을 검증하여 접근이 되지 않습니다. 이 크롬 익스텐션은 네이버에서 검색되는 것을 허용한 게시글을 번거롭게 검색하여 접근하지 않고도 자연스럽게 카페 내에서 볼 수 있도록 하는 프로그램입니다. 단, 네이버에서 검색되는 것을 허용한 게시글에만 동작합니다.

## Key Differences

Many Naver Cafe bypass extensions exist on the Chrome Web Store. However, as of March 2024, Naver has added JWT tokens to enhance link security, causing many extensions to malfunction. This program retrieves Naver’s tokens and appends them to the links, ensuring uninterrupted access to the posts without being affected by the new security measures.

크롬 익스텐션 스토어에는 이미 많은 네이버 카페 프리패스가 존재합니다. 그러나 2024년 3월을 기점으로 네이버에서 jwt 토큰을 추가하여 링크 보안을 강화하였습니다. 이에 따라 많은 익스텐션이 정상적으로 동작하지 않고 있습니다. 본 프로그램은 네이버의 토큰을 그대로 가져와서 링크에 자연스럽게 추가하도록 개발하였습니다. 따라서 해당 보안 정책에 방해받지 않으면서 카페 게시글 접근이 가능합니다.

## Important Notes

This program is developed using Manifest V3 (MV3). Unlike MV2, MV3 imposes significant restrictions on controlling HTTP requests/responses. Therefore, this extension modifies response using content scripts. If the extension does not function correctly after installation or toggling its status, a page refresh may be required.

본 프로그램은 MV3으로 개발되었습니다. MV2와 다르게 HTTP 요청/응답 제어에 제한이 많기 때문에 content 스크립트를 사용하여 응답값을 수정하는 방식을 사용합니다. 따라서 익스텐션 설치 혹은 활성화/비활성화 시에 기능이 정상적으로 동작하지 않는 경우, 새로고침이 필요할 수 있습니다.

## Install

* Chrome
  * 크롬 웹스토어는 기존 배포된 익스텐션 존재여부와 관계없이 로그인 우회같은 기능은 정책에 위반된다고 업로드가 불가능합니다.
  * src 내 `manifest-chrome.json` 을 `manifest.json` 으로 변경
  * chrome://extensions/ 로 이동
  * 개발자 모드(Developer Mode) 활성화
  * "Load Unpacked" 클릭
  * manifest.json 혹은 src 경로 선택

* Firefox
  * src 내 `manifest-firefox.json` 을 `manifest.json` 으로 변경
  * about:debugging#/runtime/this-firefox 로 이동
  * "Load Temporary Add-on..." 클릭
  * manifest.json 선택

## Supported Browsers

* Chrome
* Firefox (Thanks to [@HexagonWin](https://github.com/HexagonWin))

## Open Source

This program is open-source under the GPLv3 license. Bug reports and contributions are always welcome.

본 프로그램은 GPLv3 오픈 소스 정책을 따릅니다. 또한 개인 용도로 개발된 것이라 많은 버그가 있을 수도 있습니다. 따라서 버그 신고 및 커밋은 언제나 환영입니다.