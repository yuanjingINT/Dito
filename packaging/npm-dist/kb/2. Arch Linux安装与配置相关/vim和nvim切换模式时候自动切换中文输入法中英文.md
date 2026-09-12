## vim/nvim退出插入模式自动切换为英文输入

- vim 

    在`.vimrc`写入

    ```
    " === fcitx5 状态切换与恢复 ===
    let g:fcitx_state = 1
    autocmd InsertLeave * let g:fcitx_state = system("fcitx5-remote")[0] | call job_start("fcitx5-remote -c")
    autocmd InsertEnter * if g:fcitx_state == '2' | call job_start("fcitx5-remote -o") | endif
    autocmd VimEnter * call job_start("fcitx5-remote -c")
    ```

- 在`~/.config/nvim/init.lua`写入

    ```
    -- fcitx5 状态切换与恢复
    local fcitx_st = ""
    vim.api.nvim_create_autocmd("InsertLeave", { callback = function() fcitx_st = vim.fn.system("fcitx5-remote") vim.fn.jobstart("fcitx5-remote -c") end })
    vim.api.nvim_create_autocmd("InsertEnter", { callback = function() if fcitx_st:match("2") then vim.fn.jobstart("fcitx5-remote -o") end end })
    vim.api.nvim_create_autocmd("VimEnter", { callback = function() vim.fn.jobstart("fcitx5-remote -c") end })
    ```
