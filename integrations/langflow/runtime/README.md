# Desktop 의 Langflow 실행 환경 잠금 파일

AIF Langflow Desktop 설치본은 처음 실행할 때 이 잠금 파일로 Langflow 환경을 설치한다(`desktop-shell/runtime.js`).
설치 도구는 uv 0.11.29, 대상은 Python 3.13(uv managed), 옵션은 `--require-hashes --no-deps` 이다.

| 파일 | 내용 |
| --- | --- |
| `pinned.in` | 공식 Langflow Desktop 1.11.0 설치본의 Python 환경(P0~P3 검증에 쓴 환경)을 `uv pip freeze` 한 목록. 로컬 wheel 로 설치된 `langflow`·`langflow-base`·`lfx*` 는 같은 버전의 PyPI 이름으로 바꿨다 |
| `requirements.lock.txt` | `pinned.in` 을 해시까지 고정한 잠금 파일(패키지 566개). 설치본에 들어간다 |
| `langflow-desktop-1.11.0-constraints.txt`, `-overrides.txt` | 공식 Desktop 설치 파일에 들어 있는 제약 파일(참고용 기록) |

다시 만들기 (공식 Desktop 이 설치된 PC):

```bash
UV="$LOCALAPPDATA/com.LangflowDesktop/uv/uv.exe"
"$UV" pip freeze --python "$LOCALAPPDATA/com.LangflowDesktop/.langflow-venv/Scripts/python.exe" > freeze.txt
# freeze.txt 의 "이름 @ file:///…/이름-버전-py3-none-any.whl" 줄을 "이름==버전" 으로 바꿔 pinned.in 으로 저장
"$UV" pip compile pinned.in --python-version 3.13 --python-platform windows --generate-hashes --no-header --no-deps -o requirements.lock.txt
```

주의:

- 잠금 파일이 바뀌면 설치본은 다음 실행 때 실행 환경을 새로 만든다(Flow·설정은 남는다).
- Langflow 버전을 올릴 때는 포크 태그(`build-fork.ps1` 의 `$Tag`·`$Commit`)와 이 잠금 파일을 같은 버전으로 함께 바꾸고 P0~P4 점검을 다시 돌린다.
- `google-search-results` 는 wheel 이 없어 설치 때 소스에서 빌드한다. 설치 폴더 경로가 아주 길면 Windows 경로 길이 제한(260자)에 걸려 실패한다. 기본 경로(`%LOCALAPPDATA%\com.aif.LangflowDesktop`)에서는 문제없다. 깊은 임시 폴더로 시험하다 실제로 한 번 실패했다.
- `build==1.5.1` 은 PyPI 에서 yanked 로 표시돼 있다. 공식 Desktop 이 쓰던 버전이라 그대로 둔다(uv 가 경고만 낸다).
