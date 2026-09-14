import os

# app.main 을 import 하면 모듈 수준에서 create_app() 이 실행된다. 실제 .env 를 읽지 않게 한다.
os.environ["AIF_SKIP_DOTENV"] = "1"
