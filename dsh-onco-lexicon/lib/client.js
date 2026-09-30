// dsh-onco-lexicon —— 浏览器半（手写的 DSH client 模块）
//
// 模块协议：window.__ModuleLoader__.load({ id, factory })，
// factory 内用 require("react") 取 React，导出 apply / inject。
//
// 与 host 半的通信走同源 HTTP：POST /dsh-onco-lexicon/rpc { op, args }。
// host 半已在内存里建好词典索引，这里只负责查询与渲染。
window.__ModuleLoader__.load({
  id: 'dsh-onco-lexicon',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const RPC = '/dsh-onco-lexicon/rpc'
    const PANEL_KEY = 'onco-lexicon'
    const MAX_HITS = 30

    // 词典图标：由源图缩放到 64px 并做 gamma 校正后，以 data URI 内嵌；失败时回退到
    // host 半的静态路由。重新生成见 build-icon.ps1。
    /* ICON_B64_START */
    const ICON_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAACPlSURBVHhepZsHVFXntv0d/9zkjtybnpF604uxxthrFEVUVGxRBMXesCCKKCAoNhS7AlZs2CsWEHvXqInGrtEY7EaNHo1GpZ75H79FNhJz37vvjbfH2OO0Xb4111xzrfXt7xRyu93pbrfb9Z/23Nzc/NeMjAzX0aNHXdu3b3etWLHC5e3t7WrdurVr4cKFrtOnT9vvWVlZrszMTHtl59ycnBx7n52dbXvB6/GZ9xxTcC84Buc6HOeMx/n89Hn/3V7g3PRCbrf7d/0vt6SkJDVr1kx16tTRu+++q/j4eP3+++/Kzc19+tC/bBzDsbdv39Yvv/xir263++nDbHv06JEePHig+/fv67fffnv65//zhu0A4Po3P/zls7Nv2LBBXl5eWrJkifz8/FS8eHGtXbs2/9js7Ox8IDj+8ePHOnTokBYvXqzRo0erQ4cO6tq1q2rVqqWWLVuqefPmatu2rbZu3WqA7Nu3T9OnT1e3bt3Uvn17+61hw4a2c3xkZKTmzJmjb7/91sDjfk+PkfuzF/zu6f2Pc1z/FgC2hw8fatmyZfr555/zDcrJydHAgQM1bNgw/fjjj8aA6tWr67vvvsu/KMewYfiiRYtUu3ZtFStWTF9++aWqVKmiIUOGmDGAsHz5crVu3VrffPONypQpo6pVq9r++eefGzDcB7D79etnn7t06WLnFi5c2I6rXLmyjWf37t35DPmfsNDZ/ksAoBw3x8CAgABdv37dvse47t27a968eXbM999/r4MHD/7ppjdu3NCaNWvMW2+99ZZ8fX3Vq1cv8/yuXbs0Y8YMTZw4UadOnbJ7LFy40L6HTZ999pkBOmLECO3du9fAmj17tqKiouy4jRs3KiIiwgwePHiwOnfurLp16+q9996z82Hl/yZU/gRAQSPwKMhv377dkF+5cqV9zzGxsbFGS+L46Q2a+/j4mJfwKINHLwIDA7Vt2zYLAQBIT083Kk+ePFkpKSkaOnSotmzZYmzA2D179hhDYNCoUaM0YcIEC73w8HCjPpqTmJho4+vYsaMZDjBvv/22WrRooR07dhgD/9P2FwYwMGi/fv161atXTwcOHLBBQzM2AIANmzZtMnFythMnTtjgv/jiC/Xt21c9e/Y0eqelpdm5HB8aGmpeO3/+vMaMGaNWrVopJibG6E3cY+TMmTNNC/r06WMGYhSAAVJQUJAZHBcXZ8cyNq4NKwCsf//+WrBggerXr28hwv1g2dN6VnD7EwDHjx83r3/99dd2sQEDBmjq1KlKTk42Oj+NKGBkZmZq/vz5ZjjUXbFihRm5dOlSMxowoC4sev/9923weJ5zoqOj9Y9//MMGOnbsWE2bNk379+9XSEiIGc11CBVAJPYRRICFNQ5DYBzMADDCCABhB4z46KOPLIRh1n+15QNw7do1oy0XBwgMhpbEL55s0qSJLl26lK+wWVlZFuvDhw/XBx98YAbiOUDDYIyH9gwaQatZs6YZiQ4wQH4fOXKknQ9tYQ/fhYWFGeC8AgjGeXh4qEKFCqYPhMDOnTvN8wCEEPI754wbN87CE3AYO2Hbpk0bOw8bnGzxbwFAtIjdM2fOmHEMDIQRvODgYPn7+xswznbx4kXTgX/961/mQcQQz8IAaFipUiVjEsxgoEePHjU6Q2sGA50ROT5z/XLlyhnoq1atMmYweFIrBpYvX96EDgMxnvQI2IRp06ZNrR4pW7asxT46w3hSU1NNiLknrOB3BNXJUH8CgMqIfAq6ePrIkSM6e/asGjRooLlz5xoIeO/u3bvGAHQCZDEOSpIF8OasWbMsNj/99FPzeOPGjS1bnDt3zjxGWKAvAIu3MXTKlCnavHmzeZgUCTAMHDqTPosUKWL3gpnEP3pBSPCea3JvgGGM1apVs2sQFrAQMYXZCCJM5h44NiMj468A8OHevXtWgDRq1MhOBgwQpB5wBA/hAWloh2fxIp5HqWEE4cC5xCT6gfHQGVbgUbyD5/gOUB0giFnuh6GrV682g/C+t7e3gYrn0QE8jGDynu+4B7oC7Xv37m3CjRahYRcuXNDp06dNU9AB7o0ucHyBQs1ViBo8HxJJP/zwg50EYngRdrDBCgZJBYfxhw8fNi8Q69D9q6++Mg8DBqmPcOJ36IxXGSCDJ8djPIBAZ7xFViA0AIrjiGlCks+AxHEYD1tgAe+JdwDjWBjHdaA5GYAMQ7WIx0mbgMix6M8bb7xhx7LRE+Qz4Ol0QboiHBAPqES1RixhAHUC7CA2CQWyx7p16ywUCBtAZKAAgaEACq2dUMEjeJFj0QBiH6PIGhwPcIQPXsabpDriHiA4Fy/CNM6hyIK1JUqUsPOoXHHUyy+/bHUEGQemcK1BgwbZ+EuXLm0O/FMIPF0/OxvCwcCpttAJUhVeL1mypF0I6jMQWIEn8QIDwqPEI8YDGDmfEKOK4zoUSVyHV2jP4KgneHXSH1mFkhtRw1BA4PqwjHH06NHDGJCQkGDCSybjHoDGtYsWLWoZ4dixYwYOWQVgYQwZ6fr1638FgN1RS4CA1ngaj6MBjgAikngPb0NHtIB09uGHH5pReJW4Q7AAB89jgJPqMBTP4FWUHHpDU1QbnUAHaKLwOOdwLsBQmPE7RhJanMO1rly5YoDgeeiPOCKk1AKcD/B8T/mNHQhmSEjIvweADbXkhNdee80GQzgQBk7djXfwLN7AA1Ce+ELZqdz43anniT0MRByJP1jhZAVSIJSF/lwHwAAW9YZRGEAK5j7QF0PIFoQcIQTw1CRkBIBGpEuVKmXFFMxCmMk86AnXIES4D84pX778XwFwjEe8nJPxArTlAhjKTkxjHJQj1ml8CBUMhG4Yz2fY4FCYAbVr187QHz9+vIkUIHAfQHaKIAyGHVwTdhE+XIewIPUCJjrAsYg0YwFAHMI9ScVkF3YYBWMJ1atXr2rSpEnGJAS5Zs2aTwCA9g71iRkuwkl4wunmuDgUJP5AnkIGan788cc2AASHAXKOI4gIGB4n1XEMLSwhhQegIscRk3wHQ6A9yg/TAAswoTPXJp4BCUbh7Vu3blk4cB6pEAcRDjjGCQUqSsKVrAKj8D7jA7z4+Pg/MwAAKHQYDE0FdMTzXBAjiVXSCsjiETxFAcIN8DzUZfDQn0FCV9QaPcAQAEWtMZ7rcF0Mwyuvvvqq0ZrwoQYgpwMYKQwxRVucvM/5xPz+/d+aIU5a7BcSYrUDJXi9et6Wnkm5KD5hQbbCeYwPVs6fP/8JAGwul8s8zeQFIQCyeBHhq1GjRr74YBBpEg9RrWE47S/hgEe5KcYQKrxiKN9BffQDLwMixqPMHAe4AMTv6ALXRic43+krAAaP3rx5UytWrlLv3n106PARjR03XlOmTldKaqrKlStrIPTt20dFixbRzp07zBk4AD3huoBP2d6/f/8/AwClaU6IOQwlJxOreB8VB228gOfJCgwIppB+oBhsgXYYhSIjPJzzx83MMPQEVjg1AoUPgHA8xRQhRAPFWOgx8BaxT98PyDRlmzdvUt+Q/lqXulGjRo/TrDnztX3nXoWHR2jFiuXmbQxt06a1sRlhhs0UcWQG2AuT9u3b5ypENYTxzKSQvz09PU348DY5k5MoWvASg4KupDu8TaNCQ0IIAAYe40YMGu8ibE5tDoioOMYDEoIIw44fP6Hk5DWq36C+atXyNCO5F7HOK5SdPGmypUufhg0tjfXvP0C79uzXiJjRGhk7Vjt37dOw4aO0fcduTZs23RiAbjGbVbFiRRsXDkNwmZ6DbcwVjB49+gkAqDYTnNCQE1BPDKGsBAS8CSDEIuhBYcpl3iOY0BxPIXjciDjlHMSP1EShQvriO4wP7B6okyfPaPnyZEVFDtX8+Yv19tvvqHiJkoqNHaMePXqagCJaM2ZOV/qFdGNanTr1tHvPfo0cNUbxCdOUmrZZHTt31Z69B5Q4O0lTpyVq0+YtVqQRNvQGNEOINcDDVByGWK5evTqvHabggb5UThxI/ENZTsA40gZ1AGhyUb6HZpwD2twAozCec/EcRQrGQ2limDKaUECwwsIGWIu8bGmyIiOG68ih84qNmaAK5SvJo4angnuHKGVdqoXiiJgROn/xnJYsX6KSX36pkH4DNHT4SCVMmaENG7eqX2iY1qVu0JhxEzUpbopOnflJ0UNHWDgxHhhFxoKxZAnG8Mknn5hWJSYm5gFA44KYQW9iHY+jxtAbAwEFSgEAsUqIQHmaJW6AkbAF73JTwgeh5MZch9gHFL7v2bOX0XT48JGq7lFb0UNi1a59d0VFxyh8YLSqV6+lseMmyrelnypWqKDwiDD5t/ZVxcoV5OFZU2XLlldi4jwzOrhPP23eukNxCdM0MCpaP1+4ogkT45U4e54iIiKNoW3btrOwJqOsXLlCAwdGqFmzpsaEuLi4PBGExtAL4zGQ1MYrADi5mGMwmrjGUGZaiCuUtVOnTmYwMU0PQMxDd1INgABc9+6BVpB8Xa2GalT3lHf9pvJp3lLlqlZTda+68mrYWFVreapW/fqqVb+uvJs0UUhElNp166Lm7QLUoWd3ffjZp/ryq9JatHyVegeHmA5MnBSvYSNG6eSpsxoybITmzFug7Tv3yLt+QzVuzPjb2/2xD02YNWuGAgJaWVZbunSpq9CtW7dcpDnUHEMRuDfffNNoT0pE6IhtBAxvI07oBMxwanli3mk2UHeU35nD5z2ANvRppCkJiUqau1LLFm3QosVpWrV1p/af+Un7Tp3VgrXrtXrHTk1btljz01arQ1Afpew8rK3fn9LF+9nafuiMxiQkqlS5CurQrac2bdmh2NHjNDwmVmfO/mxhQRjs2LVXg4cMV8KU6fLza6X69RsqOLiPsQHaDxkSbXoFK/z9/V2FTp486aJgYMBMfRUqVMgMJP8iilRcxDzpg5RCzqc4ARBohcFObU776Uymoh28ohNVq36tixdu6szJX7R/71mdPXlHvr6dNH9Nis7duqv9p8/p8oMM/XDhgk5eu6BT1y/Lu0lLjZ64WOnXc7Vt11mdPefSlq2HVK5CNSUtWKHxE+I0euwEnU+/bCBMnJxggtgtsKf2fvudZs9J0oQJk7V27XoFBvZQlSpV1aiRjzEUnSLV9u7d21UoOTnZhSrieVIEYkXeJATwOKjBBOIYZpDeyN/ONHRebK20cziWGptQoXECkJIlSyikb5jOnv5Vm9Yf1cWfMpSy+qDq1WuhaYuW6tD5C7r+KFOHzl/SiatXdE+Z+vbkUdXwaqBZSVu0Y89FHfn+uq6mP9akcXNU37uZ+vQJM+8fP/mjBkZGKy5+mjZs2qbefUIMhDHjJmnmzDnasWOPwsIi7X2lSlXUtWs30yGcCuurVKniKhQaGuqiPMVgUg61OqoNdVFS6m9oDjOYuCQVYjRpEmEEDN4DCPU49CLlkRlgQ8eOHdSubVft2XFWv1yS0tYe175dP6tz5xANih2jK7890vdnz+v4hcu6J+nHW5e049h3atmus0IjJ+rw6bs6d+6eNm74QWvX7tWXJcurb0ikzpy7qOhhIxQ/ZboJIppAWEybnqiANu00cWKcRo4cbWl22LAYE8/IyCibMaK3QLjLlCnjKuTr6+siTzPlhWDBAGfqiUkPtIDSmNqc7EAhAwjkWV4RTmoCOjJEkPAgvqDYli2bTXg6d+ypm9eytW9nuo4d+VUnjt9WA5+WCg6P1JH0Kzpx5YruSzp9/ZIOnjum83duqknLNooYlqAT6Y+0c/dZXb+epaSkdapWzVMbNu7RgMhoxU+bobXr0tQzKFibtmzXhAlxGjGCjnWAPvroEy1dutKAGD16vNUPLVo0t4oSUSRsrRs8deqUi36amRcoTxFE9YZK0qeT7ylX8TDv0QOKHIwkI+Bxppv4jrwPi15//XULA+p/9CV8wBBtTD2kM8dduno5U3t2n1PkoLFq7N9OJ6/dEg/Zzt+9ocMXz+jKo7s6cO6UQgYNV2TMNKXtPqMrV7N15swtJSTMU+MmvoocNEJxU2YoeU2KuvcI0rYdeyx1jo4dq1279umrr0jNQerbN1SrVq3RggVL9NlnhW2OgNSMtuHIzz777MmTIQyE6ngUiiB2GEJ2oAQmb6L8hAefMRBldR6IABwAIKZ0XZS+HBsRMVABrTvqyKEL2ph6QEOGTNK8eWvVLTBU5SvW0IIlazRjTpLGThqn2QvmKDI6WsNHjdTQmHFq4dtJkVFjFBERo5CQKDO8SJHimj13vlLTNqlrYE/rByZNTtC4sRO1fftu+fu3NgC6du2uadNmKiVlgzp37ioPj5pmI7UOdQwMLl26dB4ANCiIAiIGMpTF9Oj//Oc/jTIoPpMXhAJiR4zzO5mBjEF1BWvQDXptQgqGUB8QOn4t22jn9u/UulUHtWjRSj6Nm8vLq6GqVa2pgFYd1Cc4RP36hVjz0j2wm8LDQzVk8HDFDB+vjh0CVbVaTZUpW1FvvPm2ihYrrr6hIfJp1FgzZ821Yqh+fR8tWbLCukOo/uqrr2nIkOFKS9uk4OAQDRw4SIULf5H/fIGxAUDFihVdhVatWuWiCUIEKT2hLV6H0tTReBeVJ0vwmVSJUFLsUCMAAC0zwkibyYQJMzykTHp8WPThBx/Lu56PevbsrcRZc3Xi9E+6/ssdXb16Qw8f5T2oeJTxux48uqesnEw9znqgtA2bNWBAlLzq1NfnnxfRu+++r5dfeVUvvPiinn3uWX388acqWbKUXnrpZZUq9ZUCA6lGI1SixJeW+318GlsIpKZuUPXqHmrRwtfqFOoVgIChxYoVcxWqVKmSi8FS1mI0dTIiQd9N7UyNT9zwCgDvvPOOxRJVIJ0ZoolWkBLpE5hDfO65Z/Xiiy9ac/PMM8/o+ef/oSJFiql48aJq1KSBlq5Y5nTgzEVJypKUCQz2zXc/HFbFSpX1/gcfqerXNdTSr7XF+ocffaxSX5Uxlf/4k0/1/555xrJTmTLlFBs71oDo1q2Hvf/gg4+UlLTIlJ+YHzlylDkPR+NkZpxmzZrlKuTh4eHCADwMzSl9qdwoYJycCQPIBggjqZGLMPNDeYwu8D2l8fPPP69Spb7UW2+9qbp162nr1h3yrOWlv/3tb6bAAwcOUJ9+vfTz5Z+UnZsltztLubkZ+XtO7mNlu3N0/debGjp8hCKjojV67CRrbsj1b7zxlooVLyHP2nX05ltvq/AXRVSzpqe8vOqqdOmy8vT00vTpierRI0j16tVXQEBbNWrU2MZHyoallO48zCWsJ06c6Cp0+PBh1507d+yhKBsCiKehOCBgPPFOJiDWye90euyAA+2JdfSC1IcA0jJT9589+7OGD4s1LzGIo0d/UJduHbRj72Yz1u3O/AsAGbmZYmr2/sPHVtd71PTSvKRFCu4ToldeeVXP/f3vqlS5qlLWb1LU4KGqXKWqPvnkU1WuXMUAIOap/r7+uoY6duxsBpO+iX2yFmFLKDDRExsb+yQL0BLzFAj1h8rOTA6qThVIV+d0eo7xzM6gqqRCwgKjX3nlFYv9zz8vrDFjJsjfr61GjRynOnXq5s0DDotWZHS4ct2sN3hifG5upnLYLSSkS1evqU7d+lq9Nk1ZOVJg917ybemv+QuXqKFPY23bsVvpF68ZGHFxU7Ry5Wqr9ubNYxZqoIoVK6EmTZoZMxF5ahvSPExnigwx37Vr15MJEQC4fPmyeZBJEGKabhC1xMMYyQQFtT/CyLQY4odwEg4AAjveeedtaz7i46eqQoVKih4co6xM2cBatmylcRMmyL91S/3quvIUAIRDrtzmf2lSfIKaNmuh266H1ud71PTU2Z8u2G9xCVNVperXVgWiB0uWLLd05+fXWkFBfTR06AhjwHvvfaAVK1bmP2XCscx5kOqZKKUK/tOcIHmceQFaWxhA4cNJIEdjgw4ABEBREGE8ExuEB8AAHDdAZYsWLaaQvuHKeJz3mC0zQ/YZ9ab3+OWXqyaAfwoDNAFYcrLVKyhYY8dP1qTJ083LlLmZ2W7luskYOdb/v//+hwpo015Tpkw32tN0TZ48xd63bdvBMkBa2kYLi82bt1vaZow0ROjd5s2bnzCAapBan1IW48jfCBwZAfGgEOJ3ps0xEBEh51M3QDGKIzICirtuXYrCw6Lk59tGJ46d08MHOUpesV51vRqofbsuatq0mS5dvMhkvNx/GO+8ZitHj7Iz1SMoSCNixqiGh6d5f+r0RP16J28F2KEfjqu2Vz3FJUxXn76hmpU4V0lJC9WpUxetWZOiXr2CtWfPfqWmblRoKI/FvlVMTKw5lFqHMKeHWbly5RMG0NCAEA8PAAADncUOdHZ4Fi8zo+o8WSEVIpLspBbm5nk8RgGSmyONH5egFs1bKXHmfHnXa6T1Kds0NWGWWrVqo4cPf5db2crKJvXlKleZynFnKBMhzMlSRGSkidy58xe1em2qxX1w3366dOW6OncJ1KjYsbp05Rc1atzUPB4aOkABAe00YEC4Dh78QcuWrbJskJxM5xqu4OC+Vrn6+/uZ4yjZmzdvnscAsgAzpUxgYBTzZ4iHs3SFBRG8wgp+Y7qaeEcbAIsJRuYMYcPbb7M2sKVu3riLXQru3V8fvP+xklel6diRc6rv3UipqWnmySwz9pEuXE3Xr/duKUeZynQ/llturd+0weL88JGTIojuuH5TWHiUqlarbkafPnNe4ydMNjCPnzhtGcDDo5YOHTpq/UD37kFasSLZKkNfXz+NHz/JbKKeQQCpeby8vPKyAJ4ldUFfjIQixDwVIaJIAUFXBwi0vMQPaZJGh8KJTEBHCK3i4+Os+mvdKkBr12zQt/sOqX37zjbz6+PTVAkJU5WVlS23O9sAWLRsoSpUqqDoYYPkenDbQMh2Z+re7/c1LGaEGTxhUoIeZWTrxi2Xps+co7DwSIt9gPj++6PW91P/r1q11nY8fuDAITMcLSJL0A5Tv8BsWM54jQGsEGEpC1UfhQ3z8NQEPCZDMCgdKYwAgMaHNpmcymQHbKEFpvQlvmACaZMURO5/9tnnNDBiiA4fOqHu3XsqOXmd8pYe5AkjVG/u+40iosLUsFEDrVi93H7LdOeVx/cf/a7Fy5Zr5qzZcv32u3JypWy3NGnyNIv99ItXTRSZYA0KCtaiRcusFd65c6+9vvDCi2rYsJFln9Kly5iOIe48+8TRKSkprkIsac/LAXkLnZ2NNYCgRVGE8jsrsPA8tAdFnug4D0mZGwAEavO2bdurTZt2Vo/PnbNADx9k6+HDDGVk5KjgUt6LVy/Lu0E9rUlN1oCI/oqbMsm+z1KGMt1ZynajDXkbr5k5OcrKcSvHDXg5BsaVa9dMVMPCwjVwYJQ2btyqFi1aqlix4mrWrLnKlaugVq0CrC5Bx5wFVrD7xo0brkKs1edxOIukAKDgam8WP6DshAOGUgSRQ+kGEU1CgblAlrWTPZhkIIwmTpyk+/cf6d69Py+nzSaN5fIgNu/zvQf31bFLB8XEjtCoMTFak5Js35sW5D5WjnAItUGO7Q5zstzZ+u3hPd2+d1txCfH6qlQpc878+SzOrmM9QXT0UNOEunW9VbZsOSuSaNxwFgUbDrQlMogg1KbsZUWYszlPi2EBbTDtLj0/PTUF0ksvvWS/cQ4aQGPEjDEPN2mu6CkSE+fq6NGTevDgoS2zu337rrEgK9Otxxl5bDt4eL86d+2krTs362HmAz3O/l3ZyjBxfPD4nh5k3NWd327q2s0r2rFnm9alrdHI0SPl07ih/Fq1VPESJay97dOnr4oXL6kWLfxsDpCQ8PZuqBdffMl6hdq1vUy0nUUUVK75a4So6JgMwZMsiS24lo5yl3ihkvqjeLC6HjShETpACiS1OIuY+OzhUcMmIcqUKa9WrVrbJAQTE4GBvRQRHqVBg4dozISxiokdrl7BPTV0xBBjwqAhkRo+cqjCIvqrU9f2trf091VtL081auqjWrVryqNWTbXr0FbP/f1ZK71r1KhpekO8U3EOjBykKQnT9dprr6tWLS99800LPfvsszbnQTWLppHK81eKQmPSGipOZ4iXeVTuLJYiz1MSQ3tSHSFAKkT0aC54AAKy6AAiSIwxRwgg8fEJGjNmbP6iiJiYkabAfn7+atuug8LCIgzEzl06m8BCTRhFOFkxVt9bNT09FD1ssGbOma7Ant207+BeTYofrzreXuoVFKQiXxTXZ58UV8f2gYocOETfHTiqwYNGqJV/OzVq1FRNm32jhIRplhWoaxBtwLh48WIeAKyb4Qd2YpkOCro7q8ZgBbHDjCpFEdmBfAo7SJNQin6AY5gH4BiA4oEJ9UF4eJiFEBUlwO3Zs9uaI3L0mtXrbCEFCg2QbJTXXMNZtR4cEmRC6dPER2tTV2vd+jWKHBRmYVOvvrda+3fU+DGzVbZMVa1bs0UJcTM1MGKw2gR0sHucOfOTXXfXrrz/GVDvPPfcc8x4PymF8RrtLIY7zwPZnGUzxDo0p5cm/jme75zlMzwvQGXRABhC18XxGE0n6azdIQVlZmbo9OkzVqr269dftWrVtMaKzAPgzrQ1wG/ZukVVqlU2z7dp11r1GtQ14UzbvF7tOrazfmDm9EXakvaDAvy7q0dgqHwaNpWnZ20FBfXSpUtXRXLDDthFY8R/HRDzqKioJytFT548actXmAqnTOQEZ3V4wY2VIc5aPn7Ds8QUIQITWFTJYmrqBuehKO0nDROlKOGGIC5btly+vv4KDOxu4cI/UNj43xDgUZyx5ebmaGLcBDX9prGJYKcuHVS7jqdaBfD/hKIqVuxL9e8XrYvnH8qjegO9/NLratiwqRITZysjI2+J/+3bd2y8lPoA7Wx/WSpLumPygCIHqrIIyQGCMOHPEgX/G8TOBXlihMjRJTobgCKSTD3BLDSG92QO4htNQK2PHTthMU9BxW/oDfSnOMsbZK5lhs7dOmnC5HG6++C2xowfrbr1vPXuv95TpcrV1LN7qL7bf0Hh/WNVonhZzZ61wM6lZWe/d++uxfzLL7+kbds2Kzc3LwPZUlknBNigIC0xHmCAUNfZnCVyVIkOCLyyIJn4x/MFCyl+AxSyBddEAGEJoUIBdeUK7TD/Njmp2NhRRk9nrT8lq3MNwmD33l2qWLGCwiLC9duje+oS2FlJC5aqb0iU+oUOUW1PHy1duFXXL2Wre7dQ9QjsrZxsaeHCBXYeWoQgM18ZERGezwwDoOCMkLPRGvOkyFkiz4bxL7zwglETuvJ9wXOe3gAKujODzPQThRZexlA2wodjnKk4No7BeAAjFbOMhZTauHETC6/GTZrobPqP6tS1owZGDtX587d1+vQtValSW4vnb9O+XemaNXO5PGvV08EDx5Xx+LE9DqdfYU5j/vwk0xaW5LLlp8H8EfybjdqAFpj0SB3g/BkK4wmBp73uZA5e6booiBBORBO9YACsR4JtDpu4Bq88neJ4FjSiBWQAihcnHP38/RU3dbICe3TVoMEx4n9b27cfVY/AAYroP94evaX/dE+NfHw1csQEZWe5NW36NJvTYNzMcuFU5w9f/yMAGAjhwEWIUVIIc4UFBdKpGp3VprxHD5hqh36EFM8LmIZihgmRBAB253yuR4+BwTCMDMMcJM0LTsjJztGq5FXya+2n1m38NW58gnn/yJHrGjt6urxqNdfPZ7J0cN95Jc1dI58GLfTdgePWIO3bd0ApKWlavDhvOt4hLkXgfwSAgfDnA5oIHodRK7BOzxFHNocNTlg43ofO0J5UCKXNi35+VjI7RrM5oPE/QGabnLAAKISUWVyOve26o45dO6p4yaLq3KWndu06rUuXHmvh/A1q1KCtZk5J0dHDV3T7hlvtAoLUp3e4zUc6Gxn98WN6nXwh/88AFIxz1uLyIBRjCgLgHOd8hmYUS86TGOYAySJsVH2U1QXTK+chptQftONs/I4mIF4F/5q7fsN6vfb6q/q6em0dPHBBmzYe06mTd9ShfV91bBuqm1elE0euKy11n+rVbaz93x628/IY6lZWFmDnM9cA+Os/IP+PG0DxTNH5dxlCBrXJFs4fKZ+uL5io5Bzo7mxMv8M6soazIWyc/847H2ra1JU6cexXXb6SqZiYGWrerLOWLdyrlUt3aOGCZAW07qSpU2bln+t0k/mf/vjz9H/8+7zz93Tn/dO/F9yZXxg2bJgrMjLSPj969MjOTUpKchUuXNjVvn17nkS50tPT88/hb/EcP3ny5Py/1R87doxnlvb9iRMn7DtnDKzw/OijT10xMTNcV69ku3bv/tF1YH+6y6dhgKt5ky6uht7+rm+a+bsWL1ztun7tV1dOLtd87HK7H7ncbv6C/+Tv8/8fSjvZ+ImfZV8AAAAASUVORK5CYII='
    /* ICON_B64_END */

    /**
     * 图标来源按顺序回退：内嵌 data URI -> host 半的静态路由 -> 文字。
     *
     * 之所以要两条来源：内嵌 base64 依赖构建期注入（build-icon.ps1），只要这个环节
     * 在别的机器上没跑到（重新打包、只拷源码目录、构建中断等），data URI 就是空的，
     * 图标会直接消失。多一条由 host 半按需读取 PNG 文件的路由，就不依赖构建产物了。
     */
    const ICON_URL = '/dsh-onco-lexicon/icon.png'
    const ICON_SOURCES = [ICON_DATA_URI, ICON_URL].filter(Boolean)

    const CATEGORIES = [
      ['disease', '疾病'],
      ['concept', '基础概念'],
      ['biomarker', '标志物 / 靶点'],
      ['drug', '抗肿瘤药物'],
      ['endpoint', '临床试验终点'],
      ['method', '实验方法'],
      ['treatment', '治疗方式'],
    ]
    const CATEGORY_LABEL = Object.fromEntries(CATEGORIES)

    /** 工厂作用域的 ctx（apply 时注入），供 sidebar 图标点击时切换栏目 */
    let ctxRef = null

    async function rpc(op, args) {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args: args || {} }),
      })
      return await res.json()
    }

    // 配色说明
    // --------
    // DSH 主题暴露的变量前缀是 `--dsw-alias-*`（如 --dsw-alias-label-primary /
    // --dsw-alias-border-l2 / --dsw-alias-bg-layer-1），**不是** `--dsh-*`。
    // 早先误用了 `--dsh-*`，导致所有 var() 都落到 fallback，而 fallback 是按深色
    // 主题写的（#e6e6e6 近白文字），在浅色主题下文字几乎看不见。
    // 现在改为紫系显式配色，并保留 --dsw-alias-* 作为可被主题接管的来源。
    // 另外把原先靠 opacity 淡化的次级文字改成显式深紫——"颜色太浅"正是它造成的。
    const CSS = `
.onco-wrap{
  --onco-ink:#4c1d95;      /* 标题：最深的紫 */
  --onco-ink-2:#5b21b6;    /* 正文 */
  --onco-ink-3:#6d28d9;    /* 次级文字 / 标签（不再用 opacity 淡化） */
  --onco-accent:#7c3aed;   /* 选中态填充 */
  --onco-line:var(--dsw-alias-border-l2,#ddd6fe);
  --onco-soft:var(--dsw-alias-bg-layer-1,#faf5ff);
  --onco-field:#ffffff;
  display:flex;flex-direction:column;height:100%;min-height:0;padding:14px 16px;gap:10px;
  font-size:13px;box-sizing:border-box;color:var(--onco-ink-2)}
@media (prefers-color-scheme: dark){
  .onco-wrap{
    --onco-ink:#ede9fe;
    --onco-ink-2:#ddd6fe;
    --onco-ink-3:#c4b5fd;
    --onco-accent:#7c3aed;
    --onco-line:var(--dsw-alias-border-l2,rgba(196,181,253,.30));
    --onco-soft:var(--dsw-alias-bg-layer-1,rgba(124,58,237,.12));
    --onco-field:rgba(255,255,255,.06)}
}
.onco-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.onco-input{flex:1;min-width:180px;padding:7px 10px;border-radius:6px;
  border:1px solid var(--onco-line);background:var(--onco-field);
  color:var(--onco-ink);font-size:13px;outline:none}
.onco-input::placeholder{color:var(--onco-ink-3);opacity:.75}
.onco-input:focus{border-color:var(--onco-accent);
  box-shadow:0 0 0 2px rgba(124,58,237,.18)}
.onco-btn{padding:7px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;
  border:1px solid var(--onco-line);background:transparent;color:var(--onco-ink-2)}
.onco-btn:hover{background:rgba(124,58,237,.10);border-color:var(--onco-accent)}
.onco-btn.on{background:var(--onco-accent);border-color:var(--onco-accent);color:#fff}
.onco-btn:disabled{opacity:.55;cursor:default}
.onco-sel{padding:7px 8px;border-radius:6px;font-size:13px;
  border:1px solid var(--onco-line);background:var(--onco-field);color:var(--onco-ink)}
.onco-meta{font-size:12px;line-height:1.5;color:var(--onco-ink-3)}
.onco-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px}
.onco-card{border:1px solid var(--onco-line);border-radius:8px;padding:9px 11px;background:var(--onco-soft)}
.onco-title{font-weight:600;font-size:13.5px;margin-bottom:4px;word-break:break-word;color:var(--onco-ink)}
.onco-score{float:right;font-weight:500;font-size:11px;color:var(--onco-ink-3)}
.onco-row{font-size:12px;line-height:1.65;word-break:break-word;color:var(--onco-ink-2)}
.onco-k{color:var(--onco-ink-3);margin-right:4px}
/* def 现在可能是「中文释义 + 空行 + 英文释义」两段，需要保留换行 */
.onco-def{font-size:12px;line-height:1.6;margin-top:3px;color:var(--onco-ink-2);white-space:pre-wrap}
.onco-tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;margin-right:5px;
  color:var(--onco-ink);background:rgba(124,58,237,.14);border:1px solid rgba(124,58,237,.38)}
/* 出处标识徽标：NCIt / 自建库 / 中文 / 外部编码 */
.onco-badges{display:flex;flex-wrap:wrap;gap:4px;margin:3px 0 6px}
.onco-badges .onco-tag{margin-right:0}
.onco-tag-seed{background:var(--onco-accent,#7c3aed);border-color:var(--onco-accent,#7c3aed);color:#fff;font-weight:600}
.onco-tag-zh{background:rgba(124,58,237,.24)}
.onco-tag-code{background:transparent;border-style:dashed}
/* 筛查条 */
.onco-filters{gap:6px}
.onco-flabel{font-size:12px;color:var(--onco-ink-3);margin-right:2px}
/* 语义类型下拉有 122 项，限宽免得把筛查条撑爆 */
.onco-sel-type{max-width:230px}
/* 导出结果等提示 */
.onco-notice{font-size:12px;line-height:1.5;word-break:break-all;padding:6px 9px;border-radius:6px;
  color:var(--onco-ink);background:rgba(124,58,237,.12);border:1px solid rgba(124,58,237,.32)}
/* 词条卡片上的「关联」入口 */
.onco-rel-btn{float:right;margin-left:8px;font-size:11px;padding:1px 8px;border-radius:99px;cursor:pointer;
  color:var(--onco-ink);background:rgba(124,58,237,.14);border:1px solid rgba(124,58,237,.38)}
.onco-rel-btn:hover{background:var(--onco-accent,#7c3aed);border-color:var(--onco-accent,#7c3aed);color:#fff}
/* 关联推荐视图 */
.onco-related{border:1px solid rgba(124,58,237,.35);border-radius:8px;padding:9px 11px;
  background:rgba(124,58,237,.07);max-height:42%;overflow:auto;flex:0 0 auto}
.onco-rel-head{display:flex;align-items:center;justify-content:space-between;gap:8px;
  font-size:12.5px;font-weight:600;color:var(--onco-ink);margin-bottom:7px}
.onco-rel-group{margin-bottom:7px}
.onco-rel-title{font-size:11.5px;color:var(--onco-ink-3);margin-bottom:3px}
.onco-rel-items{display:flex;flex-wrap:wrap;gap:4px}
.onco-rel-item{font-size:11.5px;padding:2px 8px;border-radius:99px;cursor:pointer;max-width:100%;
  color:var(--onco-ink-2);background:transparent;border:1px solid var(--onco-line);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.onco-rel-item:hover{border-color:var(--onco-accent,#7c3aed);background:rgba(124,58,237,.12)}
.onco-rel-empty{font-size:11.5px;color:var(--onco-ink-3)}
/* 性能统计面板 */
.onco-perf-group{margin-bottom:14px}
.onco-perf-title{font-size:12px;font-weight:600;color:var(--onco-ink);margin-bottom:5px;
  padding-bottom:3px;border-bottom:1px solid var(--onco-line)}
.onco-perf-row{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:1.9}
.onco-perf-k{flex:0 0 132px;color:var(--onco-ink-3)}
.onco-perf-v{color:var(--onco-ink);font-variant-numeric:tabular-nums}
.onco-perf-hint{font-size:11px;color:var(--onco-ink-3)}
/* 翻译模式：多行原文输入 */
.onco-bar-tr{align-items:flex-start}
.onco-ta{flex:1 1 auto;min-height:88px;max-height:200px;resize:vertical;padding:7px 9px;border-radius:6px;
  border:1px solid var(--onco-line);background:var(--onco-field);color:var(--onco-ink);
  font-size:12.5px;line-height:1.6;font-family:inherit;outline:none;box-sizing:border-box}
.onco-ta::placeholder{color:var(--onco-ink-3);opacity:.75}
.onco-ta:focus{border-color:var(--onco-accent);box-shadow:0 0 0 2px rgba(124,58,237,.18)}
/* 翻译结果 */
.onco-tr{display:flex;flex-direction:column;gap:9px}
.onco-notes{border-left:3px solid rgba(124,58,237,.45);padding:4px 0 4px 8px;background:rgba(124,58,237,.06);
  border-radius:0 6px 6px 0}
.onco-note{font-size:11.5px;line-height:1.6;color:var(--onco-ink-3)}
.onco-tr-primary{display:flex;flex-direction:column;gap:5px}
.onco-tr-group{display:flex;flex-direction:column;gap:5px}
.onco-tr-ghead{font-size:12px;font-weight:600;color:var(--onco-ink);
  padding-bottom:3px;border-bottom:1px solid var(--onco-line)}
.onco-tr-row{display:flex;align-items:baseline;gap:7px;font-size:12px;line-height:1.75;
  padding:2px 0;border-bottom:1px dashed rgba(124,58,237,.14)}
.onco-tr-src{flex:0 0 auto;max-width:34%;color:var(--onco-ink-2);font-weight:600;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.onco-tr-arrow{flex:0 0 auto;color:var(--onco-ink-3)}
.onco-tr-dst{flex:1 1 auto;color:var(--onco-ink);word-break:break-word}
.onco-tr-none{color:var(--onco-ink-3);font-style:italic}
.onco-tr-meta{flex:0 0 auto;font-size:11px;color:var(--onco-ink-3)}
.onco-tr-empty{font-size:12px;color:var(--onco-ink-3)}
.onco-tr-missing{margin-top:5px;display:flex;flex-direction:column}
.onco-tr-annot{font-size:12.5px;line-height:1.95;color:var(--onco-ink-2);white-space:pre-wrap;
  word-break:break-word;padding:7px 9px;border-radius:6px;border:1px solid var(--onco-line);
  background:var(--onco-soft)}
.onco-tr-hit{color:#fff;background:var(--onco-accent,#7c3aed);border-radius:4px;padding:0 3px;
  font-weight:600;cursor:help}
.onco-hint{font-size:11px;color:var(--onco-ink-3)}
.onco-err{color:var(--dsw-alias-state-error-primary,#b91c1c);font-size:12px}
.onco-empty{font-size:12.5px;padding:14px 0;text-align:center;color:var(--onco-ink-3)}
.onco-icon{display:flex;align-items:center;justify-content:center;width:100%;height:100%;
  cursor:pointer;font-size:11px;border:none;background:transparent;color:inherit;padding:0}
.onco-icon:hover{color:var(--onco-accent,#7c3aed)}
/* 图标：边框放在外层，白底也放在外层（源图是浅灰线稿+白底）。
   这里**不做**深色主题反相 —— 源图反相后是「浅灰线 + 黑底」，在深色侧边栏上会糊成一片，
   看起来就像图标没加载。保持白底圆形徽标在明暗两种主题下都清晰可见。 */
.onco-icon-badge{display:block;width:20px;height:20px;border-radius:50%;overflow:hidden;
  background:#fff;border:1px solid rgba(124,58,237,.45);box-sizing:border-box}
.onco-icon:hover .onco-icon-badge{border-color:var(--onco-accent,#7c3aed);
  box-shadow:0 0 0 2px rgba(124,58,237,.22)}
.onco-icon-img{display:block;width:100%;height:100%;object-fit:cover}
.onco-crash{padding:14px;font-size:12px;white-space:pre-wrap;overflow:auto;
  color:var(--dsw-alias-state-error-primary,#b91c1c)}
`

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById('onco-lexicon-css')) return
      const el = document.createElement('style')
      el.id = 'onco-lexicon-css'
      el.textContent = CSS
      document.head.appendChild(el)
    }

    // ---- 单个词条卡片 ----
    /**
     * host 侧两种返回形状并存：
     *   search / abbr -> 扁平的 `{...entry, score, via}`
     *   browse        -> `{...entry}`（同样扁平）
     * 这里统一成 entry，避免上层误取 `hit.entry` 拿到 undefined 而在渲染时抛错。
     */
    function normalizeHit(hit) {
      if (!hit) return { entry: null, score: undefined, via: undefined }
      const entry = hit.entry || hit
      return { entry, score: hit.score, via: hit.via }
    }

    // ---- 数值格式化（性能面板用）----
    function num(n) {
      return typeof n === 'number' ? n.toLocaleString('en-US') : '—'
    }
    function fmtBytes(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—'
      const units = ['B', 'KB', 'MB', 'GB']
      let i = 0
      let v = n
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i++
      }
      return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i]
    }
    function fmtMs(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—'
      return (Math.round(n * 100) / 100).toFixed(2) + ' ms'
    }

    /** 把当前结果拼成纯文本。用 CRLF —— Windows 记事本才不会把换行吃掉。 */
    function resultsToText(query, mode, hits, dictLabel, fuzzy) {
      const L = []
      L.push('# 肿瘤学术语词典 导出')
      L.push('# 词典：' + (dictLabel || '?'))
      L.push('# 模式：' + mode + (fuzzy ? '（模糊检索）' : ''))
      L.push('# 查询：' + (query || '（类别浏览）'))
      L.push('# 时间：' + new Date().toLocaleString())
      L.push('# 条数：' + hits.length)
      L.push('')
      hits.forEach((raw, i) => {
        const { entry: e, score, via } = normalizeHit(raw)
        if (!e) return
        L.push(`${i + 1}. ${e.zh ? e.zh + '（' + e.en + '）' : e.en}`)
        if (score !== undefined) L.push(`   相关度：${score}`)
        if (via) L.push(`   匹配：${via}`)
        L.push(`   类别：${CATEGORY_LABEL[e.category] || e.category || '—'}`)
        if (e.types && e.types.length) L.push(`   NCIt 类型：${e.types.join('；')}`)
        if (e.abbr && e.abbr.length) L.push(`   缩写：${e.abbr.join('、')}`)
        if (e.aliases && e.aliases.length) L.push(`   别名：${e.aliases.join('；')}`)
        if (e.parents && e.parents.length) L.push(`   上位概念：${e.parents.join('；')}`)
        const codes = Object.entries(e.codes || {})
        if (codes.length) L.push(`   编码：${codes.map((kv) => kv[0].toUpperCase() + ':' + kv[1]).join('，')}`)
        if (e.def) L.push(`   释义：${String(e.def).replace(/\s*\n+\s*/g, ' / ')}`)
        if (e.sources && e.sources.length) L.push(`   出处：${e.sources.join(' + ')}`)
        L.push(`   ID：${e.id}`)
        L.push('')
      })
      L.push('以上内容来自本地离线词典，仅供科研与文献理解参考，不构成诊疗建议；')
      L.push('编码与释义请以官方词表（NCIt / MeSH）最新版本为准。')
      return L.join('\r\n')
    }

    /** 翻译对照的纯文本导出。与界面同一份数据、同一套判断，便于直接贴进文档。 */
    function translationToText(tr, dictLabel) {
      const L = []
      const dirLabel = tr.direction === 'zh2en' ? '中→英' : '英→中'
      L.push('# 肿瘤学术语词典 翻译对照导出')
      L.push('# 词典：' + (dictLabel || '?'))
      L.push('# 方向：' + dirLabel + (tr.autoDirection === tr.direction ? '（自动判定）' : '（手动指定）'))
      L.push('# 时间：' + new Date().toLocaleString())
      L.push(
        '# 命中：' + tr.stats.distinctTerms + ' 个术语（可对照 ' + tr.stats.translatedTerms + '） / ' +
          tr.stats.spans + ' 处，覆盖原文字符 ' + (tr.stats.coverage * 100).toFixed(1) + '%',
      )
      L.push('# 注意：本文件是离线词典的逐词对照，不是机器翻译，未做语序调整与整句润色。')
      L.push('')
      if (tr.primary) {
        L.push('## 最相近词条')
        L.push(
          (tr.primary.zh ? tr.primary.zh + '（' + tr.primary.en + '）' : tr.primary.en) +
            (tr.primaryVia ? '   匹配依据：' + tr.primaryVia : ''),
        )
        L.push('')
      }
      const target = (e) => (tr.direction === 'zh2en' ? e.en : e.zh)
      const translated = (tr.terms || []).filter((t) => !t.missing)
      const missing = (tr.terms || []).filter((t) => t.missing)
      L.push('## 术语对照（' + translated.length + '）')
      if (!translated.length) L.push('（无可对照术语）')
      translated.forEach((t, i) => {
        L.push(`${i + 1}. ${t.surface || t.key} → ${target(t) || '—'}`)
        L.push(
          `   类别：${CATEGORY_LABEL[t.category] || t.category || '—'}` +
            (t.abbr && t.abbr.length ? `；缩写：${t.abbr.join('、')}` : '') +
            `；原文出现 ${t.count} 次`,
        )
        const codes = Object.entries(t.codes || {})
        if (codes.length) L.push(`   编码：${codes.map((kv) => kv[0].toUpperCase() + ':' + kv[1]).join('，')}`)
        if (t.types && t.types.length) L.push(`   NCIt 类型：${t.types.join('；')}`)
        L.push(`   ID：${t.id}`)
      })
      L.push('')
      L.push('## 词典未收录目标语言名的命中（' + missing.length + '）')
      if (!missing.length) L.push('（无）')
      missing.forEach((t, i) => {
        L.push(
          `${i + 1}. ${t.surface || t.key} → （词典未收录` +
            `${tr.direction === 'zh2en' ? '英文名' : '中文名'}）   ` +
            `类别：${CATEGORY_LABEL[t.category] || t.category || '—'}；出现 ${t.count} 次`,
        )
      })
      L.push('')
      L.push('## 原文（命中的可对照术语用 [[ ]] 标出对照名）')
      let annotated = ''
      for (const s of tr.segments || []) {
        if (s.term && !s.term.missing) {
          const shown = tr.direction === 'zh2en' ? s.term.en : s.term.zh
          annotated += `${s.text}[[${shown}]]`
        } else {
          annotated += s.text
        }
      }
      L.push(annotated)
      L.push('')
      L.push('以上内容来自本地离线词典，仅供科研与文献理解参考，不构成诊疗建议；')
      L.push('编码与释义请以官方词表（NCIt / MeSH）最新版本为准。')
      return L.join('\r\n')
    }

    function Card(props) {
      const e = props.entry
      if (!e) return null
      const rows = []
      const push = (label, value) => {
        if (value) rows.push(h('div', { className: 'onco-row', key: label },
          h('span', { className: 'onco-k' }, label), value))
      }
      push('缩写：', (e.abbr || []).join('、'))
      push('别名：', (e.aliases || []).join('；'))
      push('类别：', CATEGORY_LABEL[e.category] || e.category)
      // NCIt 权威语义类型：比 7 个粗类别精确得多，直接展示，便于判断归类是否可信
      push('NCIt 类型：', (e.types || []).join('；'))
      push('上位概念：', (e.parents || []).join('；'))
      const codes = Object.entries(e.codes || {})
      if (codes.length) push('编码：', codes.map((kv) => kv[0].toUpperCase() + ':' + kv[1]).join('，'))
      push('来源：', e.source)

      // 出处标识：结构化 sources（NCIt / 自建库）打成一排徽标，
      // 再附上「中文」「MeSH」这类从字段推出的能力标记，便于一眼看出这条词条的来路。
      const srcs = e.sources && e.sources.length ? e.sources : []
      const badges = []
      for (const s of srcs) badges.push({ text: s, kind: s === '自建库' ? 'seed' : 'ncit' })
      if (e.zh) badges.push({ text: '中文', kind: 'zh' })
      const codeKinds = [...new Set(codes.map((kv) => kv[0].toUpperCase()))]
      for (const c of codeKinds) badges.push({ text: c, kind: 'code' })

      const title = e.zh ? e.zh + '（' + e.en + '）' : e.en
      return h('div', { className: 'onco-card' },
        h('div', { className: 'onco-title' },
          props.onRelated && e.id
            ? h('button', {
                className: 'onco-rel-btn',
                title: '查看上位 / 下位 / 名称近似的术语',
                onClick: () => props.onRelated(e),
              }, '关联')
            : null,
          props.score === undefined ? null : h('span', { className: 'onco-score' }, '得分 ' + props.score),
          title,
        ),
        badges.length
          ? h('div', { className: 'onco-badges' },
              badges.map((b, i) => h('span', {
                key: b.text + i,
                className: 'onco-tag onco-tag-' + b.kind,
                title: b.kind === 'seed' ? '来自人工整理的自建库' : b.kind === 'ncit' ? '来自 NCIt 本体' : b.text,
              }, b.text)))
          : null,
        e.via ? h('div', { className: 'onco-row' }, h('span', { className: 'onco-k' }, '匹配：'), e.via) : null,
        rows,
        e.def ? h('div', { className: 'onco-def' }, e.def) : null,
        e.id ? h('div', { className: 'onco-row' }, h('span', { className: 'onco-k' }, 'ID：'), e.id) : null,
      )
    }

    /** 性能统计面板：索引规模 / 内存 / 查询耗时 */
    function PerfPanel(props) {
      const p = props.data
      if (!p) return h('div', { className: 'onco-empty' }, '正在读取性能数据…')
      const row = (k, v, hint) =>
        h('div', { className: 'onco-perf-row', key: k },
          h('span', { className: 'onco-perf-k' }, k),
          h('span', { className: 'onco-perf-v' }, v),
          hint ? h('span', { className: 'onco-perf-hint' }, hint) : null)
      const group = (title, rows) =>
        h('div', { className: 'onco-perf-group', key: title },
          h('div', { className: 'onco-perf-title' }, title),
          rows)
      return h('div', { className: 'onco-list' },
        group('索引 / 词典', [
          row('词典', p.dictLabel || '—'),
          row('加载耗时', fmtMs(p.loadMs), '插件初始化时同步建索引'),
          row('词典体积', fmtBytes(p.dictBytes)),
          row('词条数', num(p.index.docs)),
          row('检索键数', num(p.index.keys), '名称/别名/缩写/编码去重后的标签数'),
          row('词项数', num(p.index.terms), '分词后的 token 词表'),
          row('倒排项数', num(p.index.postings)),
          row('NCIt 类型数', num(p.index.typeCount)),
          row('下位索引键数', num(p.index.childKeys)),
        ]),
        group('内存 / 进程', [
          row('常驻内存 RSS', fmtBytes(p.memory.rss)),
          row('堆已用', fmtBytes(p.memory.heapUsed)),
          row('堆总量', fmtBytes(p.memory.heapTotal)),
          row('外部内存', fmtBytes(p.memory.external)),
          row('运行时长', num(p.process.uptimeSec) + ' s'),
          row('Node', p.process.node + ' · ' + p.process.platform),
        ]),
        group('查询耗时（本次会话）', [
          row('查询次数', num(p.queries.count), '不含本面板自身的刷新'),
          row('最近一次', fmtMs(p.queries.lastMs)),
          row('平均', fmtMs(p.queries.avgMs)),
          row('p50 / p95', fmtMs(p.queries.p50Ms) + ' / ' + fmtMs(p.queries.p95Ms)),
          row('最慢', fmtMs(p.queries.maxMs)),
          row('样本数', num(p.queries.samples), '只保留最近若干次'),
        ]),
        p.loadError ? h('div', { className: 'onco-err' }, '加载错误：' + p.loadError) : null,
      )
    }

    /**
     * 翻译对照结果。
     *
     * 一个刻意的取舍：**只有「能给出目标语言名」的命中才在原文里高亮**。
     * 词典里 185,885 条绝大多数是纯英文 NCIt（带中文名的只有 106 条），若把所有命中
     * 都高亮，一段英文摘要里的 And / With / Patient / Cell 会全部亮起来，反而盖住了
     * 真正能翻译的那几个术语。无译名的命中不隐藏，收在下面可展开的清单里。
     */
    function TranslateResult(props) {
      const tr = props.data
      const [showMissing, setShowMissing] = React.useState(false)
      if (!tr) return h('div', { className: 'onco-empty' }, '正在对照…')
      const dirLabel = tr.direction === 'zh2en' ? '中→英' : '英→中'
      const target = (e) => (tr.direction === 'zh2en' ? e.en : e.zh)
      const terms = tr.terms || []
      const translated = terms.filter((t) => !t.missing)
      const missing = terms.filter((t) => t.missing)
      const pct = ((tr.stats.coverage || 0) * 100).toFixed(1)

      const row = (t, i) =>
        h('div', { className: 'onco-tr-row', key: (t.id || '') + (t.key || '') + i },
          h('span', { className: 'onco-tr-src' }, t.surface || t.key),
          h('span', { className: 'onco-tr-arrow' }, '→'),
          h('span', { className: 'onco-tr-dst' + (t.missing ? ' onco-tr-none' : '') },
            t.missing ? '（词典未收录' + (tr.direction === 'zh2en' ? '英文名' : '中文名') + '）' : target(t) || '—'),
          h('span', { className: 'onco-tr-meta' },
            (CATEGORY_LABEL[t.category] || t.category || '—') + (t.count > 1 ? ' · ' + t.count + ' 次' : '')),
          props.onRelated && t.id
            ? h('button', {
                className: 'onco-rel-btn',
                title: '查看该词条的关联术语',
                onClick: () => props.onRelated(t),
              }, '关联')
            : null,
        )

      return h('div', { className: 'onco-tr' },
        h('div', { className: 'onco-meta' },
          '方向 ' + dirLabel + (tr.autoDirection === tr.direction ? '（自动判定）' : '（手动指定）') +
            ' · 命中术语 ' + tr.stats.distinctTerms + ' 个（可对照 ' + tr.stats.translatedTerms + '）' +
            ' · 共 ' + tr.stats.spans + ' 处 · 覆盖原文字符 ' + pct + '%'),
        (tr.notes || []).length
          ? h('div', { className: 'onco-notes' },
              tr.notes.map((n, i) => h('div', { className: 'onco-note', key: i }, '· ' + n)))
          : null,
        tr.primary
          ? h('div', { className: 'onco-tr-primary' },
              h('div', { className: 'onco-tr-ghead' }, '最相近词条'),
              h(Card, { entry: tr.primary, via: tr.primaryVia, onRelated: props.onRelated }))
          : null,
        h('div', { className: 'onco-tr-group' },
          h('div', { className: 'onco-tr-ghead' }, '术语对照（' + translated.length + '）'),
          translated.length
            ? translated.map(row)
            : h('div', { className: 'onco-tr-empty' }, '词典中没有可对照的术语。')),
        missing.length
          ? h('div', { className: 'onco-tr-group' },
              h('button', {
                className: 'onco-btn',
                onClick: () => setShowMissing((v) => !v),
              }, (showMissing ? '收起 ' : '展开 ') + missing.length + ' 个无译名命中'),
              showMissing ? h('div', { className: 'onco-tr-missing' }, missing.map(row)) : null)
          : null,
        h('div', { className: 'onco-tr-group' },
          h('div', { className: 'onco-tr-ghead' }, '原文标注'),
          h('div', { className: 'onco-tr-annot' },
            (tr.segments || []).map((s, i) =>
              s.term && !s.term.missing
                ? h('span', {
                    className: 'onco-tr-hit',
                    key: 'h' + i,
                    title: '原文「' + s.text + '」→ ' + (target(s.term) || '—') +
                      '（' + (CATEGORY_LABEL[s.term.category] || s.term.category || '') + '）',
                  }, s.text)
                : s.text,
            )),
          h('div', { className: 'onco-hint' },
            '未收录译名的命中不做高亮，以免通用词盖住真正可翻译的术语。'),
        ),
      )
    }

    // ---- 主面板 ----
    function SearchPanel() {
      const [mode, setMode] = React.useState('search')
      const [q, setQ] = React.useState('')
      const [category, setCategory] = React.useState('') // '' = 全部类别
      const [source, setSource] = React.useState('') // '' = 全部出处
      const [ncitType, setNcitType] = React.useState('') // '' = 全部 NCIt 语义类型
      const [hits, setHits] = React.useState([])
      const [meta, setMeta] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [err, setErr] = React.useState('')
      const [touched, setTouched] = React.useState(false)
      const [fuzzy, setFuzzy] = React.useState(false) // 模糊检索开关
      const [perf, setPerf] = React.useState(null) // 性能统计数据
      const [related, setRelated] = React.useState(null) // 当前词条的关联推荐
      const [notice, setNotice] = React.useState('') // 导出结果等提示
      const [ta, setTa] = React.useState('') // 翻译模式的原文（多行）
      const [dir, setDir] = React.useState('auto') // 翻译方向 auto / zh2en / en2zh
      const [tr, setTr] = React.useState(null) // 翻译对照结果

      React.useEffect(() => {
        let alive = true
        rpc('stats')
          .then((r) => {
            if (!alive) return
            if (r.ok) setMeta(r)
            else setErr(r.error || '词典状态获取失败')
          })
          .catch((e) => alive && setErr(String((e && e.message) || e)))
        return () => { alive = false }
      }, [])

      // 进入「性能统计」时拉一次性能数据
      React.useEffect(() => {
        if (mode !== 'perf') return undefined
        let alive = true
        setNotice('')
        rpc('perf')
          .then((r) => {
            if (!alive) return
            if (r.ok) setPerf(r)
            else setErr(r.error || '性能数据获取失败')
          })
          .catch((e) => alive && setErr(String((e && e.message) || e)))
        return () => { alive = false }
      }, [mode])

      /**
       * 统一入口。over 用于把「刚改动的那个值」直接带进来，避免依赖尚未生效的 state。
       * 筛查条件对三种模式都生效（检索 / 缩写 / 浏览）。
       */
      async function run(over = {}) {
        const md = over.mode === undefined ? mode : over.mode
        const query = (over.q === undefined ? q : over.q).trim()
        const cat = over.category === undefined ? category : over.category
        const src = over.source === undefined ? source : over.source
        const typ = over.type === undefined ? ncitType : over.type
        const fz = over.fuzzy === undefined ? fuzzy : over.fuzzy
        setBusy(true)
        setErr('')
        setTouched(true)
        setNotice('')
        setRelated(null) // 新一次检索会换掉结果集，关联视图随之失效
        try {
          const args = { limit: MAX_HITS }
          if (cat) args.category = cat
          if (src) args.source = src
          if (typ) args.type = typ
          if (fz) args.fuzzy = true
          let r
          if (md === 'browse') {
            args.limit = 50
            r = await rpc('browse', args)
          } else {
            args.q = query
            r = await rpc(md === 'abbr' ? 'abbr' : 'search', args)
          }
          if (!r.ok) { setErr(r.error || '查询失败'); setHits([]); return }
          setHits(md === 'browse' ? (r.entries || []).map((e) => ({ entry: e })) : (r.hits || []))
        } catch (e) {
          setErr(String((e && e.message) || e))
          setHits([])
        } finally {
          setBusy(false)
        }
      }

      /**
       * 翻译对照。走独立入口而不是复用 run()：翻译吃的是多行文本，
       * 与单行检索的 q 分开保存，免得切模式时把段落塞进检索框。
       */
      async function runTranslate(over = {}) {
        const text = (over.text === undefined ? ta : over.text).trim()
        const d = over.dir === undefined ? dir : over.dir
        if (!text) {
          setNotice('请先粘贴或输入要对照的文本')
          return
        }
        setBusy(true)
        setErr('')
        setTouched(true)
        setNotice('')
        setRelated(null)
        try {
          const r = await rpc('translate', { text, direction: d, limit: 400 })
          if (!r.ok) {
            setErr(r.error || '翻译失败')
            setTr(null)
            return
          }
          setTr(r)
        } catch (e) {
          setErr(String((e && e.message) || e))
          setTr(null)
        } finally {
          setBusy(false)
        }
      }

      function switchMode(md) {
        setMode(md)
        setHits([])
        setTouched(false)
        setErr('')
        setNotice('')
        setRelated(null)
        if (md === 'browse') run({ mode: 'browse' })
      }

      /** 关联推荐：以某个词条为中心，取上位 / 下位 / 名称近似 */
      async function showRelated(entry) {
        if (!entry || !entry.id) return
        setBusy(true)
        setErr('')
        setNotice('')
        try {
          const r = await rpc('related', { id: entry.id, limit: 8 })
          if (!r.ok) { setErr(r.error || '关联查询失败'); return }
          setRelated(r)
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      /** 导出当前结果为 txt（由 host 半写文件，返回落盘路径） */
      async function doExport() {
        let text = ''
        let countText = ''
        let name = ''
        const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
        if (mode === 'translate') {
          if (!tr || (!(tr.terms || []).length && !(tr.segments || []).length)) {
            setNotice('当前没有可导出的对照结果')
            return
          }
          text = translationToText(tr, meta ? meta.dictLabel : '')
          countText = ` ${tr.stats.distinctTerms} 个术语对照`
          name = `onco-lexicon-translate-${stamp}.txt`
        } else {
          if (!hits.length) {
            setNotice('当前没有可导出的结果')
            return
          }
          text = resultsToText(q, mode, hits, meta ? meta.dictLabel : '', fuzzy)
          countText = ` ${hits.length} 条`
          name = `onco-lexicon-${stamp}.txt`
        }
        setBusy(true)
        setErr('')
        setNotice('')
        try {
          const r = await rpc('export', { text, name })
          if (!r.ok) {
            setErr(r.error || '导出失败')
            return
          }
          setNotice(`已导出${countText}到 ${r.path}`)
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      function clearFilters() {
        setCategory('')
        setSource('')
        setNcitType('')
        run({ category: '', source: '', type: '' })
      }

      /** 关联推荐视图：以某个词条为中心的上位 / 下位 / 名称近似，点任一项可继续外扩 */
      function renderRelated() {
        const r = related
        const describe = (e) => (e.zh ? e.zh + '（' + e.en + '）' : e.en)
        const groupOf = (title, items, extra) =>
          items && items.length
            ? h('div', { className: 'onco-rel-group', key: title },
                h('div', { className: 'onco-rel-title' }, `${title}（${items.length}）`),
                h('div', { className: 'onco-rel-items' },
                  items.map((e, i) =>
                    h('button', {
                      key: (e.id || '') + i,
                      className: 'onco-rel-item',
                      title: '以该词条为中心继续查看关联',
                      onClick: () => showRelated(e),
                    }, describe(e) + (extra && extra(e) ? ` · ${extra(e)}` : '')))))
            : h('div', { className: 'onco-rel-group', key: title },
                h('div', { className: 'onco-rel-title' }, title),
                h('div', { className: 'onco-rel-empty' }, '无'))
        return h('div', { className: 'onco-related' },
          h('div', { className: 'onco-rel-head' },
            h('span', null, '关联推荐：' + (r.seed ? describe(r.seed) : '')),
            h('button', { className: 'onco-btn', onClick: () => setRelated(null) }, '关闭关联')),
          groupOf('上位概念', r.parents),
          groupOf('下位概念', r.children),
          groupOf('名称近似', r.similar, (e) => (typeof e.score === 'number' ? `相似度 ${e.score}` : '')),
        )
      }

      const modes = [
        ['search', '术语检索'],
        ['translate', '翻译'],
        ['abbr', '缩写消歧'],
        ['browse', '类别浏览'],
        ['perf', '性能统计'],
      ]
      // 翻译模式不挂筛查条：段落对照要的是「原文里有什么」，按类别筛掉一半术语
      // 只会让标注看起来漏词。筛查留给检索 / 缩写 / 浏览三种模式。
      const canExport = mode === 'translate'
        ? !!(tr && ((tr.terms || []).length || (tr.segments || []).length))
        : hits.length > 0
      const catOptions = [['', '全部类别'], ...CATEGORIES]
      const srcOptions = [['', '全部出处'], ['NCIt', 'NCIt 本体'], ['自建库', '自建库（人工整理）']]
      // NCIt 语义类型是权威维度，按词条数降序（122 种，原生下拉可键盘检索）
      const typeEntries = meta && meta.byType
        ? Object.entries(meta.byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        : []

      return h('div', { className: 'onco-wrap' },
        h('div', { className: 'onco-bar' },
          modes.map(([id, label]) =>
            h('button', {
              key: id,
              className: 'onco-btn' + (mode === id ? ' on' : ''),
              onClick: () => switchMode(id),
            }, label),
          ),
        ),
        mode === 'perf'
          ? null
          : mode === 'translate'
            ? h('div', { className: 'onco-bar onco-bar-tr' },
                h('textarea', {
                  className: 'onco-ta',
                  value: ta,
                  rows: 5,
                  placeholder: '粘贴要对照的术语或整段文本（中英均可）。例如：\n' +
                    'Patients with advanced non-small cell lung cancer received cisplatin.\n' +
                    '注意：这是词典式逐词对照，不是机器翻译，不做语序调整与整句润色。',
                  onChange: (ev) => setTa(ev.target.value),
                  onKeyDown: (ev) => {
                    // Ctrl/Cmd + Enter 触发对照：多行输入里回车该留给换行
                    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) runTranslate()
                  },
                }),
                h('select', {
                  className: 'onco-sel',
                  value: dir,
                  title: '对照方向',
                  onChange: (ev) => {
                    setDir(ev.target.value)
                    if (tr) runTranslate({ dir: ev.target.value })
                  },
                }, [
                  h('option', { key: 'auto', value: 'auto' }, '自动判定方向'),
                  h('option', { key: 'zh2en', value: 'zh2en' }, '中 → 英'),
                  h('option', { key: 'en2zh', value: 'en2zh' }, '英 → 中'),
                ]),
                h('button', {
                  className: 'onco-btn on',
                  disabled: busy,
                  onClick: () => runTranslate(),
                }, busy ? '对照中…' : '翻译对照'),
                h('button', {
                  className: 'onco-btn',
                  disabled: busy || !canExport,
                  title: '把当前对照结果导出为 txt',
                  onClick: doExport,
                }, '导出 TXT'),
              )
            : h('div', { className: 'onco-bar' },
                mode === 'browse'
                  ? null
                  : h('input', {
                      className: 'onco-input',
                      value: q,
                      placeholder: mode === 'abbr'
                        ? '输入缩写，例如 OS、PD、MM、PD-L1'
                        : '中文 / 英文 / 缩写 / 别名 / 编码，例如 非小细胞肺癌、NSCLC、奥希替尼、D002289',
                      onChange: (ev) => setQ(ev.target.value),
                      onKeyDown: (ev) => { if (ev.key === 'Enter') run() },
                    }),
                mode === 'browse'
                  ? null
                  : h('button', { className: 'onco-btn on', disabled: busy, onClick: () => run() }, busy ? '查询中…' : '查询'),
                mode === 'browse'
                  ? null
                  : h('button', {
                      className: 'onco-btn' + (fuzzy ? ' on' : ''),
                      title: '按编辑距离（≤2）找出拼写相近的术语，略慢',
                      onClick: () => { const next = !fuzzy; setFuzzy(next); run({ fuzzy: next }) },
                    }, '模糊检索'),
                h('button', {
                  className: 'onco-btn',
                  disabled: busy || !hits.length,
                  title: '把当前结果导出为 txt',
                  onClick: doExport,
                }, '导出 TXT'),
              ),
        // 筛查条：检索 / 缩写 / 浏览三种模式下生效（性能统计与翻译不涉及筛查）
        mode === 'perf' || mode === 'translate'
          ? null
          : h('div', { className: 'onco-bar onco-filters' },
              h('span', { className: 'onco-flabel' }, '筛查'),
              h('select', {
                className: 'onco-sel',
                value: category,
                title: '按类别筛查',
                onChange: (ev) => { setCategory(ev.target.value); run({ category: ev.target.value }) },
              }, catOptions.map(([id, label]) => h('option', { key: id || '__all', value: id }, label))),
              h('select', {
                className: 'onco-sel',
                value: source,
                title: '按术语出处筛查',
                onChange: (ev) => { setSource(ev.target.value); run({ source: ev.target.value }) },
              }, srcOptions.map(([id, label]) => h('option', { key: id || '__all', value: id }, label))),
              h('select', {
                className: 'onco-sel onco-sel-type',
                value: ncitType,
                title: '按 NCIt 权威语义类型精确筛查',
                onChange: (ev) => { setNcitType(ev.target.value); run({ type: ev.target.value }) },
              }, [
                h('option', { key: '__alltype', value: '' }, '全部 NCIt 类型'),
                ...typeEntries.map(([t, n]) => h('option', { key: t, value: t }, `${t} (${n})`)),
              ]),
              (category || source || ncitType)
                ? h('button', { className: 'onco-btn', onClick: clearFilters }, '清除筛查')
                : null,
            ),
        meta && mode !== 'perf'
          ? h('div', { className: 'onco-meta' },
              '词典：' + (meta.dictLabel || '?') + ' · 共 ' + meta.total + ' 条' +
              (meta.byCategory ? ' · ' + Object.entries(meta.byCategory).map((kv) => (CATEGORY_LABEL[kv[0]] || kv[0]) + ' ' + kv[1]).join(' / ') : '') +
              (meta.bySource ? ' · 出处 ' + Object.entries(meta.bySource).map((kv) => kv[0] + ' ' + kv[1]).join(' / ') : ''),
            )
          : null,
        notice ? h('div', { className: 'onco-notice' }, notice) : null,
        err ? h('div', { className: 'onco-err' }, err) : null,
        related ? renderRelated() : null,
        mode === 'perf'
          ? h(PerfPanel, { data: perf })
          : mode === 'translate'
            ? h('div', { className: 'onco-list' },
                tr
                  ? h(TranslateResult, { data: tr, onRelated: showRelated })
                  : touched && !busy
                    ? h('div', { className: 'onco-empty' }, '没有可对照的内容。')
                    : h('div', { className: 'onco-empty' },
                        '粘贴术语或整段文本后点「翻译对照」。词典只做术语级对应，不做机器翻译。'),
              )
            : h('div', { className: 'onco-list' },
                hits.length
                  ? hits.map((raw, i) => {
                      const { entry, score, via } = normalizeHit(raw)
                      return h(Card, {
                        key: (entry && entry.id) || i,
                        entry,
                        score,
                        via,
                        onRelated: showRelated,
                      })
                    })
                  : touched && !busy
                    ? h('div', { className: 'onco-empty' }, '没有匹配的词条。可试试「模糊检索」，或放宽 / 清除筛查条件，也可换用英文名、缩写或编码。')
                    : h('div', { className: 'onco-empty' }, '输入关键词后回车即可查询；也可以切换到「类别浏览」逐类翻看。'),
              ),
      )
    }

    /** 渲染异常兜底：面板出错不影响 GUI 其它部分 */
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: null } }
      static getDerivedStateFromError(error) { return { error } }
      render() {
        if (this.state.error) {
          return h('div', { className: 'onco-crash' },
            '术语词典面板渲染出错（已拦下）：\n' + String((this.state.error && this.state.error.stack) || this.state.error))
        }
        return this.props.children
      }
    }
    function PanelSafe() { return h(Boundary, null, h(SearchPanel, null)) }

    /**
     * 侧边栏图标。逐个尝试 ICON_SOURCES；都加载不出来才退回文字。
     * 用 onError 而不是预先判断，是因为「能不能加载」只有浏览器试过才知道
     * （data URI 可能被 CSP 拦、静态路由可能没注册）。
     */
    function PanelIcon() {
      const [idx, setIdx] = React.useState(0)
      const src = ICON_SOURCES[idx]
      return h('button', {
        className: 'onco-icon',
        title: '肿瘤学术语词典',
        'aria-label': '肿瘤学术语词典',
        onClick: () => {
          try { if (ctxRef && ctxRef.layout) ctxRef.layout.selectPanel(PANEL_KEY) } catch { /* ignore */ }
        },
      }, src
        ? h('span', { className: 'onco-icon-badge' },
            h('img', {
              className: 'onco-icon-img',
              src,
              alt: '术语词典',
              draggable: false,
              onError: () => setIdx((i) => i + 1),
            }))
        : h('span', null, '词典'))
    }

    exports.inject = ['slots', 'layout']

    exports.apply = (ctx) => {
      ctxRef = ctx
      ensureCss()
      ctx.effect(
        () => ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY }, PanelSafe)),
        'onco-lexicon: main panel',
      )
      ctx.effect(
        () => ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 45, label: '术语词典' },
            PanelIcon,
          )),
        'onco-lexicon: sidebar entry',
      )
    }

    // 冒烟测试钩子：让测试能在没有浏览器与 react-dom 的情况下直接渲染这些组件。
    // 之前正是因为缺少客户端测试，search 结果的形状不匹配才漏到了界面上。
    exports.__test = { Card, SearchPanel, Boundary, normalizeHit, TranslateResult, translationToText }

    return module.exports
  },
})
