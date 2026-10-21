@echo off
setlocal
chcp 65001 >nul
title Pre-push check - solar-3d-simulator
cd /d "%~dp0"

echo.
echo [1/3] Kiem tra cu phap JavaScript trong index.html...
node tools\check-inline-js.mjs
if errorlevel 1 (
    echo.
    echo [X] Co loi cu phap. KHONG push - sua loi truoc.
    goto :fail
)

echo.
echo [2/3] Trang thai Git:
git fetch origin --quiet
git status --short --branch
git status --porcelain | findstr /r ".*" >nul
if %errorlevel%==0 echo [!] Co file CHUA commit - push chi gui nhung gi DA commit.

echo.
echo [3/3] Chay thu tai localhost...
netstat -ano | findstr /r /c:":8123 .*LISTENING" >nul
if %errorlevel%==0 (
    echo Port 8123 da co server - dung lai server hien co.
) else (
    start "solar-server" cmd /k python -m http.server 8123
    timeout /t 1 /nobreak >nul
)
start "" http://localhost:8123/
echo Da mo http://localhost:8123/ trong trinh duyet.
echo Kiem tra truc quan: xoay/keo camera, them chuoi pin, doi loai mai, luu anh PNG...
echo.
choice /c YN /m "Push len GitHub bay gio"
if errorlevel 2 goto :skip_push

echo.
git pull --ff-only --quiet
if errorlevel 1 (
    echo [X] git pull that bai - co the co commit tren may khac. Chay git status de kiem tra.
    goto :fail
)
git push
if errorlevel 1 goto :fail
echo.
echo [OK] Da push. BUOC TIEP THEO: vao dashboard Render, chon service ve3d,
echo      bam Manual Deploy - "Deploy latest commit" de trang web cap nhat.
goto :done

:skip_push
echo.
echo Da bo qua push. Chay lai file nay khi san sang.

:done
echo.
pause
exit /b 0

:fail
echo.
echo KET THUC VOI LOI.
pause
exit /b 1
